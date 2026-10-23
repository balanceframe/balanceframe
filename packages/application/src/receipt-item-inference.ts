import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  createReceiptInferencePayload,
  receiptInferencePayloadHash,
  runReceiptItemInference,
  type ReceiptItemInferenceProvider,
} from '@balanceframe/inference';
import {
  canonicalProposalJson,
  receiptInferencePolicySchema,
  type EvidenceAccess,
  type EvidenceScope,
  type WorkflowStore,
  type ReceiptInferenceInstallation,
  type ReceiptInferenceSubject,
  type ReceiptInferencePreview,
} from '@balanceframe/workflow-store';
import type { MerchantActor } from './merchant-service.js';
const id = z.string().trim().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const receiptInferenceSelectionSchema = z
  .object({ accountId: id, receiptId: id, lineId: id, locality: z.enum(['local', 'external']) })
  .strict();
export const receiptInferenceConsentSchema = z
  .object({ previewId: id, payloadHash: hash })
  .strict();
export const receiptInferenceWithdrawalSchema = receiptInferenceConsentSchema
  .extend({ action: z.enum(['rejected', 'revoked']) })
  .strict();
const policyLayerSchema = z.object({ layer: z.enum(['space', 'budget']) }).strict();
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalProposalJson(value)).digest('hex');
type Selection = z.infer<typeof receiptInferenceSelectionSchema>;
/** Trusted installation configuration; ordinary app composition registers no providers. */
export interface ReceiptItemInferenceConfiguration {
  installation: () => ReceiptInferenceInstallation | Promise<ReceiptInferenceInstallation>;
  providers: readonly ReceiptItemInferenceProvider[];
}
export interface ReceiptItemInferenceCapture {
  scope: EvidenceScope;
  subject: ReceiptInferenceSubject;
  itemLabel: string;
  categories: { categoryId: string; label: string }[];
  sensitiveValues: string[];
  deterministic: 'resolved' | 'conflict' | 'unresolved';
  categoryId: string | null;
  fence: string;
  authorize: () => boolean;
}
export interface ReceiptItemInferenceHost {
  store: WorkflowStore;
  now: () => string;
  configuration?: ReceiptItemInferenceConfiguration;
  scope: (actor: MerchantActor) => Promise<EvidenceScope>;
  access: (actor: MerchantActor, scope: EvidenceScope) => EvidenceAccess;
  fresh: (actor: MerchantActor) => void;
  policyAuthorized: (
    actor: MerchantActor,
    scope: EvidenceScope,
    layer: 'space' | 'budget',
  ) => boolean;
  capture: (
    actor: MerchantActor,
    selection: Omit<Selection, 'locality'>,
  ) => Promise<ReceiptItemInferenceCapture>;
}
const manual = (reasonCode: string) => ({ state: 'manual' as const, reasonCode });
/** Suggestion-only receipt boundary; every asynchronous result is fenced against current source and authority. */
export class ReceiptItemInferenceService {
  constructor(private readonly host: ReceiptItemInferenceHost) {}
  private get journal() {
    return this.host.store.evidence.receiptInference;
  }
  private async context(actor: MerchantActor, selection: Selection) {
    const installation = (await this.host.configuration?.installation()) ?? null;
    const source = await this.host.capture(actor, selection);
    const access = this.host.access(actor, source.scope);
    const policies = {
      space: this.journal.policyState(access, 'space'),
      budget: this.journal.policyState(access, 'budget'),
    };
    const providers = [...(this.host.configuration?.providers ?? [])];
    const infos = providers
      .map((provider) => provider.info)
      .sort((a, b) => a.id.localeCompare(b.id));
    const subjectHash = digest({
      kind: 'receipt-item',
      actorId: actor.actorId,
      membershipId: actor.membershipId,
      policyVersion: actor.governancePolicyVersion,
      scope: source.scope,
      source: source.fence,
      subject: source.subject,
      installation,
      policies,
      providers: infos,
    });
    const allowed = (locality: 'local' | 'external') => {
      if (
        !installation ||
        !access.authorize({
          capability: `receipt-inference:${locality}`,
          document: null,
          scope: source.scope,
        })
      )
        return [];
      const layers = [installation.policy, policies.space.policy, policies.budget.policy];
      return providers
        .filter(
          (provider) =>
            provider.info.locality === locality &&
            layers.every(
              (policy) =>
                policy?.[locality].enabled &&
                policy[locality].providerIds.includes(provider.info.id),
            ),
        )
        .sort((a, b) => a.info.id.localeCompare(b.info.id));
    };
    if (!source.authorize()) throw new Error('Receipt inference source changed');
    return { source, access, installation, policies, providers, subjectHash, allowed };
  }
  private binding(subjectHash: string, provider: ReceiptItemInferenceProvider) {
    return digest({
      subjectHash,
      provider: provider.info,
      contractVersion: 'receipt-item:1',
      redactorVersion: 'receipt-label:1',
    });
  }
  private payload(source: ReceiptItemInferenceCapture, nonce?: string) {
    return createReceiptInferencePayload({
      itemLabel: source.itemLabel,
      categories: source.categories,
      sensitiveValues: source.sensitiveValues,
      ...(nonce ? { nonce } : {}),
    });
  }
  private view(record: ReceiptInferencePreview) {
    const categoryId = record.result?.categoryAlias
      ? record.aliasMapping[record.result.categoryAlias]
      : null;
    if (!categoryId) return manual('provider_abstained');
    return {
      state: 'suggested' as const,
      previewId: record.id,
      payloadHash: record.payloadHash,
      receiptId: record.subject.receiptId,
      lineId: record.subject.lineId,
      categoryId,
      provenance: { ...record.provider },
      reasonCode: 'receipt_model_suggestion' as const,
    };
  }
  private canEscalate(context: Awaited<ReturnType<ReceiptItemInferenceService['context']>>) {
    if (!context.allowed('local').length) return true;
    const local = this.journal.latestLocal(
      context.access,
      { subjectHash: context.subjectHash },
      context.installation,
    );
    return (
      !!local &&
      (local.status === 'failed' ||
        local.status === 'rejected' ||
        (local.status === 'completed' && local.result?.categoryAlias === null))
    );
  }
  private assertCurrent(
    context: Awaited<ReturnType<ReceiptItemInferenceService['context']>>,
    record: ReceiptInferencePreview,
  ) {
    if (record.provider.locality === 'external' && !this.canEscalate(context))
      throw new Error('Current local suggestion requires review');
    const provider = context
      .allowed(record.provider.locality)
      .find(
        (provider) =>
          canonicalProposalJson(provider.info) === canonicalProposalJson(record.provider),
      );
    if (
      !provider ||
      context.source.deterministic !== 'unresolved' ||
      context.subjectHash !== record.subjectHash ||
      this.binding(context.subjectHash, provider) !== record.bindingHash
    )
      throw new Error('Receipt inference authority or source changed');
    const prepared = this.payload(context.source, record.nonce);
    if (
      receiptInferencePayloadHash(prepared.payload) !== record.payloadHash ||
      canonicalProposalJson(prepared.aliasMapping) !== canonicalProposalJson(record.aliasMapping)
    )
      throw new Error('Receipt inference payload changed');
    return { provider, prepared };
  }
  async preview(actor: MerchantActor, value: unknown) {
    const selection = receiptInferenceSelectionSchema.parse(value);
    const context = await this.context(actor, selection);
    if (context.source.deterministic === 'conflict') return manual('conflicting_rules');
    if (context.source.deterministic === 'resolved' && context.source.categoryId)
      return {
        state: 'deterministic' as const,
        categoryId: context.source.categoryId,
        receiptId: selection.receiptId,
        lineId: selection.lineId,
      };
    if (selection.locality === 'external' && !this.canEscalate(context))
      return manual('local_first');
    const provider = context.allowed(selection.locality)[0];
    if (!provider) return manual('inference_unavailable');
    const bindingHash = this.binding(context.subjectHash, provider);
    const cached = this.journal.lookup(context.access, { bindingHash }, context.installation);
    if (cached) {
      this.assertCurrent(context, cached);
      return this.view(cached);
    }
    try {
      const prepared = this.payload(context.source);
      const record = this.journal.createPreview(
        context.access,
        {
          subject: context.source.subject,
          subjectHash: context.subjectHash,
          bindingHash,
          payloadHash: receiptInferencePayloadHash(prepared.payload),
          aliasMapping: prepared.aliasMapping,
          nonce: prepared.nonce,
          provider: provider.info,
        },
        context.installation,
      );
      return {
        state: 'preview' as const,
        previewId: record.id,
        payloadHash: record.payloadHash,
        expiresAt: record.expiresAt,
        provider: { ...provider.info },
        payload: prepared.payload,
      };
    } catch {
      return manual('inference_unavailable');
    }
  }
  async run(actor: MerchantActor, value: unknown) {
    const input = receiptInferenceConsentSchema.parse(value);
    this.host.fresh(actor);
    const scope = await this.host.scope(actor);
    const record = this.journal.getPreview(this.host.access(actor, scope), input);
    if (!record) throw new Error('Receipt inference preview unavailable');
    const selection = {
      accountId: record.subject.accountId,
      receiptId: record.subject.receiptId,
      lineId: record.subject.lineId,
      locality: record.provider.locality,
    };
    const context = await this.context(actor, selection);
    const { provider, prepared } = this.assertCurrent(context, record);
    this.journal.consumePreview(
      context.access,
      { ...input, bindingHash: record.bindingHash, nonce: record.nonce },
      context.installation,
    );
    try {
      const result = await runReceiptItemInference(provider, prepared.payload, async () => {
        const current = await this.context(actor, selection);
        this.host.fresh(actor);
        this.assertCurrent(current, record);
        if (
          !this.journal.readLiveDispatch(
            current.access,
            { ...input, bindingHash: record.bindingHash },
            current.installation,
          )
        )
          throw new Error('Receipt inference consent withdrawn');
      });
      const current = await this.context(actor, selection);
      this.assertCurrent(current, record);
      if (result.status !== 'suggestion') {
        this.recordFailure(current.access, input, 'unavailable');
        return manual('provider_unavailable');
      }
      const completed = this.journal.finishDispatch(
        current.access,
        { ...input, bindingHash: record.bindingHash, nonce: record.nonce, result: result.result },
        current.installation,
      );
      return this.view(completed);
    } catch {
      this.recordFailure(context.access, input, 'failed');
      return manual('inference_unavailable');
    }
  }
  private recordFailure(
    access: EvidenceAccess,
    input: { previewId: string; payloadHash: string },
    code: 'unavailable' | 'failed',
  ) {
    try {
      this.journal.failDispatch(access, input, code);
    } catch {
      /* Deleted or revoked dispatches stay withdrawn. */
    }
  }
  async withdraw(actor: MerchantActor, value: unknown) {
    const input = receiptInferenceWithdrawalSchema.parse(value);
    this.host.fresh(actor);
    const scope = await this.host.scope(actor);
    this.journal.withdraw(
      this.host.access(actor, scope),
      { previewId: input.previewId, payloadHash: input.payloadHash },
      input.action,
    );
    return { state: input.action };
  }
  async policy(actor: MerchantActor, value: unknown) {
    const { layer } = policyLayerSchema.parse(value);
    const scope = await this.host.scope(actor);
    if (!this.host.policyAuthorized(actor, scope, layer))
      throw new Error('Receipt inference policy is not authorized');
    return this.journal.policyState(this.host.access(actor, scope), layer);
  }
  async updatePolicy(actor: MerchantActor, value: unknown) {
    const input = policyLayerSchema
      .extend({ expectedRevision: id, policy: receiptInferencePolicySchema.nullable() })
      .strict()
      .parse(value);
    this.host.fresh(actor);
    const scope = await this.host.scope(actor);
    if (!this.host.policyAuthorized(actor, scope, input.layer))
      throw new Error('Receipt inference policy is not authorized');
    const access = this.host.access(actor, scope);
    return this.journal.updatePolicy(
      {
        ...access,
        authorize: (request) =>
          request.capability === 'receipt-inference:policy:manage'
            ? this.host.policyAuthorized(actor, scope, input.layer)
            : access.authorize(request),
      },
      {
        ...input,
        review: {
          membershipId: actor.membershipId!,
          policyVersion: actor.governancePolicyVersion!,
        },
      },
    );
  }
}

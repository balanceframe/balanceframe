import type { LiquidityActor, WorkflowStore } from '@balanceframe/workflow-store';
import { createWebTransactionEvidenceService } from './evidence-service';

interface EvidenceAttentionBlocker {
  code: string;
  classification: 'evidence_connector_degradation' | 'unresolved_material_evidence';
  message: string;
  severity: 'warning';
  evidence?: Array<{ evidenceId: string; kind: string; authorized: boolean; redaction: string }>;
  reasonCodes?: string[];
}
/** Return current evidence exceptions to the one existing attention surface. */
export async function evidenceAttentionPublication(
  store: WorkflowStore,
  actor: LiquidityActor,
): Promise<{ blockers: EvidenceAttentionBlocker[]; authorize: () => boolean }> {
  const allowed = () =>
    Boolean(
      actor.auth &&
      actor.spaceId &&
      store.liquidity.isAuthorized({
        ...actor,
        resourceKind: 'budget',
        resourceId: actor.budgetId,
        capability: 'normalized-evidence',
        operation: 'normalized-evidence',
        phase: 'read',
        visibility: 'resource',
      }),
    );
  if (!allowed()) return { blockers: [], authorize: () => true };
  try {
    const publication = await (
      await createWebTransactionEvidenceService(store)
    ).attentionPublication({ ...actor, auth: actor.auth!, spaceId: actor.spaceId! });
    return {
      blockers: publication.items.map((item) => ({
        code: item.id,
        classification: item.classification,
        message: item.description,
        severity: 'warning',
        reasonCodes: item.reasonCodes,
        evidence: item.evidenceIds.map((evidenceId) => ({
          evidenceId,
          kind: 'normalized_evidence',
          authorized: true,
          redaction: 'visible',
        })),
      })),
      authorize: () => allowed() && publication.authorize(),
    };
  } catch {
    return {
      blockers: [
        {
          code: 'evidence_source_unavailable',
          classification: 'evidence_connector_degradation',
          message: 'Transaction evidence is unavailable. Actual and ordinary review remain usable.',
          severity: 'warning',
        },
      ],
      authorize: allowed,
    };
  }
}

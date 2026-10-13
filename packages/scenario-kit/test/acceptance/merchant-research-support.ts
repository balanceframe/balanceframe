import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { expect, vi } from 'vitest';
import { z } from 'zod';
import type { MerchantAnalysisView, MerchantPublicSuggestion, MerchantResearchOutcome, MerchantResearchPreview, MerchantResearchQuery } from '@balanceframe/application';
import type { GovernanceResourceGrant, ResourceCapability } from '@balanceframe/workflow-store';
import type { ReviewQueueItem } from '../../../../apps/web/server/utils/workflow-store.js';
import type { LoadedScenario } from '../../src/loader.js';
import { SCENARIO_CATALOG_VERSION } from '../../src/catalog.js';
import { readScenarioManifest, writeScenarioPrivateFile } from '../../src/scenario-manifest.js';
import { scenarioRequest } from './support.js';

export type Envelope<T> = { status: 'ok'; result: T } | { status: 'error'; result: null; error: { code: string } };
export interface Reply<T> { status: number; body: Envelope<T> }
export interface PreparedResearch { query: MerchantResearchQuery; target: MerchantPublicSuggestion; view: MerchantAnalysisView }
export interface Telemetry { version: 1; generation: number; calls: number; held: number }
export interface JournalEntry { phase: string; reserved_atoms: string; settled_atoms: string | null; billing_currency: string; tariff_version: string; content_deleted: number }
interface InspectionDatabase { prepare(sql: string): { all(): unknown[] }; close(): void }
const Database = createRequire(createRequire(import.meta.url).resolve('@balanceframe/workflow-store'))('better-sqlite3') as new (filename: string, options: { readonly: boolean }) => InspectionDatabase;
const telemetrySchema = z.object({ version: z.literal(1), generation: z.number().int().nonnegative(), calls: z.number().int().min(0).max(1000), held: z.number().int().min(0).max(16) }).strict();
const journalSchema = z.object({ phase: z.string(), reserved_atoms: z.string(), settled_atoms: z.string().nullable(), billing_currency: z.string(), tariff_version: z.string(), content_deleted: z.number() }).strict();
const controlSchema = z.object({ version: z.literal(1), generation: z.number().int().nonnegative(), scenarioId: z.enum(['merchant-research-success', 'merchant-research-outage', 'merchant-research-lifecycle']), spaceId: z.string().min(1).max(512), mode: z.enum(['success', 'outage', 'held']), clockOffsetMs: z.number().int().min(0).max(7_200_000), releaseVersion: z.number().int().min(0).max(1000), cancelVersion: z.number().int().min(0).max(1000) }).strict();
export const fixtureSource = { url: 'https://merchant.example.invalid/about', title: 'Scenario fixture merchant evidence', snippet: 'Synthetic scenario fixture evidence; not live search or financial advice.' };
export const fixturePolicy = { mode: 'external-allowed' as const, allowedProviderIds: ['valueserp'], maxSearchesPerDay: 20, maxSpendMinorUnitsPerMonth: 100, billingCurrency: 'USD', cacheTtlHours: 1 };
export const testTimeout = 240_000;

export function resultOf<T>(reply: Reply<T>): T {
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  expect(reply.body.status).toBe('ok');
  if (reply.body.status !== 'ok') throw new Error('Expected successful normal research response');
  return reply.body.result;
}

export function noPrivateValues(handle: LoadedScenario, value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of [handle.processes.internalSecret, handle.processes.actualSecretKey, ...Object.values(handle.initialized.personas).flatMap((persona) => [persona.password, persona.cookieHeader])]) {
    expect(text.includes(secret)).toBe(false);
  }
  expect(text.includes('scenario-fixture-no-credential')).toBe(false);
}

function privateJson(root: string, pathname: string): unknown {
  if (!isAbsolute(pathname) || resolve(pathname) !== pathname) throw new Error('Expected canonical private fixture path');
  const child = relative(root, pathname);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Fixture file escaped owned root');
  let component = root;
  for (const segment of child.split(sep)) {
    component = join(component, segment);
    if (lstatSync(component).isSymbolicLink()) throw new Error('Fixture file is not an owned regular file');
  }
  const fd = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 16384) throw new Error('Fixture file is not private and bounded');
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally { closeSync(fd); }
}

export function telemetry(handle: LoadedScenario): Telemetry {
  const manifest = readScenarioManifest(handle.processes);
  if (!manifest.research || manifest.spaceId !== handle.initialized.spaceId || manifest.scenarioId !== handle.scenario.id) throw new Error('Expected current owned research fixture');
  const value = telemetrySchema.parse(privateJson(manifest.root, `${manifest.research.controlPath}.status`));
  expect(value.generation).toBe(manifest.generation);
  return value;
}

/** Space unique dispatches beyond the existing one-launch-per-second guard without aging source or human proof. */
export function advanceResearchClock(handle: LoadedScenario): void {
  const manifest = readScenarioManifest(handle.processes);
  if (manifest.phase !== 'ready' || !manifest.research || manifest.spaceId !== handle.initialized.spaceId || manifest.scenarioId !== handle.scenario.id) throw new Error('Expected current owned research fixture');
  const control = controlSchema.parse(privateJson(manifest.root, manifest.research.controlPath));
  if (control.generation !== manifest.generation || control.scenarioId !== manifest.scenarioId || control.spaceId !== manifest.spaceId || control.clockOffsetMs + 1001 > 7_200_000) throw new Error('Research lifecycle clock authority changed');
  writeScenarioPrivateFile(manifest.root, manifest.research.controlPath, { ...control, clockOffsetMs: control.clockOffsetMs + 1001 });
}

export function journal(handle: LoadedScenario): JournalEntry[] {
  const manifest = readScenarioManifest(handle.processes);
  const database = new Database(manifest.workflowDbPath, { readonly: true });
  try {
    return database.prepare('SELECT phase,reserved_atoms,settled_atoms,billing_currency,tariff_version,content_deleted FROM merchant_research_attempts ORDER BY created_at,id').all().map((row) => journalSchema.parse(row));
  } finally { database.close(); }
}

export function cacheRows(handle: LoadedScenario): unknown[] {
  const manifest = readScenarioManifest(handle.processes);
  const database = new Database(manifest.workflowDbPath, { readonly: true });
  try { return database.prepare('SELECT key_hash FROM merchant_enrichment_cache').all(); }
  finally { database.close(); }
}

export async function setResearchGrant(handle: LoadedScenario, resourceKind: 'budget' | 'account' | 'evidence', resourceId: string, capability: ResourceCapability, granted: boolean): Promise<void> {
  const owner = handle.initialized.personas.owner!;
  const value = resultOf(await scenarioRequest<Envelope<{ grant: GovernanceResourceGrant | null }>>(handle,
    `/api/spaces/${encodeURIComponent(owner.spaceId)}/grants`, {
      method: 'PUT', body: { membershipId: owner.membershipId, resourceKind, resourceId, capability, granted },
    }));
  if (granted) expect(value.grant).toMatchObject({ membershipId: owner.membershipId, resourceKind, resourceId, capability, granted: true, revokedAt: null });
  else expect(value).toEqual({ grant: null });
}

export async function syncLocal(handle: LoadedScenario): Promise<void> {
  const synced = resultOf(await scenarioRequest<Envelope<{ synchronized: true; failed: number }>>(handle, '/api/review/sync', { method: 'POST', body: {} }));
  expect(synced).toMatchObject({ synchronized: true, failed: 0 });
}

/** Exact desired native admission, not an assumed answer copied from a result fixture. Primary must prove this against real Actual. */
export async function localTarget(handle: LoadedScenario): Promise<PreparedResearch> {
  const transactionId = handle.seeded.transactionIds['synthetic-holdout-000-02'];
  const accountId = handle.seeded.accountIds['acct-checking'];
  const categoryId = handle.seeded.categoryIds['cat-groceries'];
  const payeeId = handle.seeded.payeeIds['pay-market'];
  if (!transactionId || !accountId || !categoryId || !payeeId) throw new Error('Expected mapped native research fixture resources');
  const view = resultOf(await scenarioRequest<Envelope<MerchantAnalysisView>>(handle, `/api/merchant?transactionId=${encodeURIComponent(transactionId)}`));
  const target = view.suggestions.find((row) => row.transactionId === transactionId);
  expect(target).toMatchObject({ transactionId, accountId, payeeId, categoryId, tier: 'inferred', supportCount: 3 });
  if (!target) throw new Error('Real Actual/native source did not admit the required sparse research target');
  expect(target.sourceTransaction).toMatchObject({ id: transactionId, accountId, categoryId: null, amount: { minorUnits: '-34607', currency: 'USD' }, importedPayee: { state: 'present', value: 'aster atelier' } });
  expect(view.categories.find((category) => category.id === categoryId)?.name).toBe('Groceries');
  expect(view.scope).toMatchObject({ spaceId: handle.initialized.spaceId, budgetId: handle.initialized.budgetId });
  const queue = resultOf(await scenarioRequest<Envelope<{ items: ReviewQueueItem[]; total: number }>>(handle, '/api/review'));
  const item = queue.items.find((row) => row.reviewItem.transactionId === transactionId);
  expect(item?.evidence.suggestedCategory).toBe('Groceries');
  expect(item?.evidence.money).toEqual({ minorUnits: '-34607', currency: 'USD' });
  expect(item?.evidence.merchantEvidence).toMatchObject({ transactionId, accountId, categoryId, payeeId, supportCount: 3 });
  return { view, target, query: { evidenceKey: target.evidenceKey, evidenceRevision: target.evidenceRevision, merchant: 'Aster Atelier', locale: null, publicBusiness: true } };
}

export async function prepareResearch(handle: LoadedScenario): Promise<PreparedResearch> {
  const transactionId = handle.seeded.transactionIds['synthetic-holdout-000-02'];
  const accountId = handle.seeded.accountIds['acct-checking'];
  if (!transactionId || !accountId) throw new Error('Missing exact native research target');
  const owner = handle.initialized.personas.owner!;
  const grants = resultOf(await scenarioRequest<Envelope<{ grants: GovernanceResourceGrant[] }>>(handle, `/api/spaces/${encodeURIComponent(owner.spaceId)}/grants`)).grants;
  const required: { resourceKind: 'budget' | 'account' | 'evidence'; resourceId: string; capability: ResourceCapability }[] = [
    { resourceKind: 'budget', resourceId: handle.initialized.budgetId, capability: 'merchant:research' },
    { resourceKind: 'account', resourceId: accountId, capability: 'merchant:research' },
    ...(['evidence', 'normalized-evidence', 'source', 'merchant:research'] as const).map((capability) => ({ resourceKind: 'evidence' as const, resourceId: `merchant:transaction:${transactionId}`, capability })),
  ];
  for (const resource of required) {
    const current = grants.filter((grant) => grant.actorId === owner.actorId && grant.membershipId === owner.membershipId && grant.resourceKind === resource.resourceKind && grant.resourceId === resource.resourceId && grant.capability === resource.capability && grant.granted && !grant.revokedAt);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ ...resource, spaceId: owner.spaceId, membershipId: owner.membershipId, granted: true, revokedAt: null });
  }
  await syncLocal(handle);
  const prepared = await localTarget(handle);
  expect(telemetry(handle).calls).toBe(0);
  expect(journal(handle)).toEqual([]);
  return prepared;
}

export async function previewResearch(handle: LoadedScenario, query: MerchantResearchQuery): Promise<Extract<MerchantResearchPreview, { status: 'ready' }>> {
  const preview = resultOf(await scenarioRequest<Envelope<MerchantResearchPreview>>(handle, '/api/merchant/research/preview', { method: 'POST', body: query }));
  expect(preview).toMatchObject({ status: 'ready', merchant: query.merchant, locale: query.locale, evidenceKey: query.evidenceKey, evidenceRevision: query.evidenceRevision, providerId: 'valueserp', providerVersion: 'scenario-fixture/1', fieldsSent: ['merchant', 'locale'], maxCostAtoms: '250000', billingCurrency: 'USD' });
  if (preview.status !== 'ready') throw new Error('Expected explicit authorized fixture preview');
  noPrivateValues(handle, preview);
  return preview;
}

export async function sendResearch(handle: LoadedScenario, query: MerchantResearchQuery, key: string): Promise<MerchantResearchOutcome> {
  const preview = await previewResearch(handle, query);
  return resultOf(await scenarioRequest<Envelope<MerchantResearchOutcome>>(handle, '/api/merchant/research', { method: 'POST', body: { ...query, previewToken: preview.previewToken, consent: true, idempotencyKey: key } }));
}

export async function cachedResearch(handle: LoadedScenario, query: MerchantResearchQuery) {
  return resultOf(await scenarioRequest<Envelope<{ enrichment: Extract<MerchantResearchOutcome, { status: 'succeeded' | 'cached' }>['enrichment'] | null }>>(handle, '/api/merchant/research/cache', { method: 'POST', body: query }));
}

export async function waitHeld(handle: LoadedScenario, calls = 1): Promise<void> {
  await vi.waitFor(() => expect(telemetry(handle)).toMatchObject({ calls, held: 1 }), { timeout: 15_000, interval: 50 });
  expect(journal(handle).filter((entry) => entry.phase === 'dispatched')).toMatchObject([{ phase: 'dispatched', reserved_atoms: '250000', settled_atoms: null, billing_currency: 'USD', tariff_version: 'scenario-fixture/1' }]);
}

/** Records only completed assertions against a real supervisor, without inventing a LoadedScenario. */
export function recordResearchDemoVerification(scenarioId: string, anchor: string, branches: readonly string[]): void {
  const { assertionCalls, currentTestName } = expect.getState();
  if (!currentTestName || assertionCalls < 1) throw new Error('Real demo verification requires completed named assertions');
  console.log(JSON.stringify({ type: 'scenario-verification', catalogVersion: SCENARIO_CATALOG_VERSION, scenarioId, anchor, status: 'passed', assertions: { name: currentTestName, count: assertionCalls }, evidence: { backend: 'disposable-actual', auth: 'better-auth' }, branches }));
}

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import type { TransactionEntity, RuleEntity } from '@actual-app/core/types/models';
import { ActualConnector, type ActualClient } from '@balanceframe/actual-adapter';
import { normalizeActualMerchantSource } from '../../actual-adapter/src/merchant-normalizer.js';
import { SqliteWorkflowStore, type GovernanceResourceKind, type ResourceGrantRestrictions } from '@balanceframe/workflow-store';
import { merchantAnalysisRequestSchema, merchantAnalysisResultSchema } from '@balanceframe/protocol-generated/validators';
import { ConnectionManager } from '../src/connection-manager.js';
import { MerchantIntelligenceService, merchantConnectionId, type MerchantActor, type MerchantNativeBindings, type MerchantServiceOptions } from '../src/merchant-service.js';
import type { NativeBindingShim } from '../src/composition.js';
import type { MerchantAnalysisResult } from '@balanceframe/protocol-generated';

const bundle = JSON.parse(readFileSync(new URL('../../../protocol/fixtures/merchant-intelligence.json', import.meta.url), 'utf8')) as { request: unknown };
export const canonical = merchantAnalysisRequestSchema.parse(bundle.request);
export const native = createRequire(import.meta.url)('@balanceframe/native') as MerchantNativeBindings & NativeBindingShim;
export const now = '2026-10-04T12:00:00.000Z';
export const accountId = 'account-checking';
export const privateAccountId = 'account-private';
export const candidateId = 'tx-candidate';
export const payeeId = 'payee-market';
export const categoryId = 'category-food';
export const evidenceKey = (id: string) => `merchant:transaction:${id}`;
export const humanAuth = (actorId: string, at = now) => ({ method: 'human-session' as const, actorId, sessionId: `session:${actorId}`, reauthenticatedAt: at });

export function transaction(fields: Partial<TransactionEntity> = {}): TransactionEntity {
  const source = canonical.transactions[0]!;
  return {
    id: candidateId, account: accountId, date: '2026-09-04', amount: -100,
    payee: payeeId, category: null, cleared: true, reconciled: false,
    imported_id: fields.id ?? 'import-candidate', imported_payee: source.importedPayee.value!,
    notes: 'PRIVATE-NOTE-DO-NOT-PUBLISH', ...fields,
  };
}
export function history(): TransactionEntity[] {
  return [
    transaction({ id: 'tx-history-1', date: '2026-06-04', category: categoryId }),
    transaction({ id: 'tx-history-2', date: '2026-07-04', category: categoryId }),
    transaction({ id: 'tx-history-3', date: '2026-08-04', category: categoryId }),
    transaction(),
  ];
}

export interface MerchantFixture {
  store: SqliteWorkflowStore;
  databasePath: string;
  manager: ConnectionManager;
  service: MerchantIntelligenceService;
  actor: MerchantActor;
  client: ActualClient;
  grant(kind: GovernanceResourceKind, id: string, capability: string, granted?: boolean, target?: MerchantActor, restrictions?: ResourceGrantRestrictions): void;
  grantSources(target?: MerchantActor, rows?: TransactionEntity[]): void;
  addMember(id: string): Promise<MerchantActor>;
  admitPatternGrants(): MerchantAnalysisResult;
  rows(): TransactionEntity[];
  setRows(rows: TransactionEntity[]): void;
  setRules(rules: RuleEntity[]): void;
  setClock(now: string): void;
  clock(): string;
  setConfig(url: string, budget?: string): void;
  onRead(callback: (() => void) | null): void;
  connector(): ActualConnector;
  cleanup(): Promise<void>;
}

/** Only SDK I/O is injected: real connector, manager, governance, SQLite and compiled native. */
export async function merchantFixture(options: { maxTransactions?: number; currency?: string; research?: MerchantServiceOptions['research'] } = {}): Promise<MerchantFixture> {
  const directory = mkdtempSync(join(tmpdir(), 'merchant-service-'));
  const databasePath = join(directory, 'workflow.sqlite');
  const store = new SqliteWorkflowStore(databasePath);
  let clockNow = now;
  let rows = history();
  let rules: RuleEntity[] = [];
  let serverUrl = 'https://actual.fixture.test/base';
  let selectedBudget = 'budget-merchant';
  let beforeRead: (() => void) | null = null;
  const accounts = [
    { id: accountId, name: 'Checking', offbudget: false, closed: false, balance_current: 0 },
    { id: privateAccountId, name: 'PRIVATE-ACCOUNT', offbudget: false, closed: false, balance_current: 0 },
  ];
  const payees = canonical.payees.map((payee) => ({ id: payee.id, name: payee.name, transfer_acct: payee.transferAccountId }));
  const categories = canonical.categories.map((category) => ({ id: category.id, name: category.name, is_income: category.isIncome, hidden: false, group_id: 'group-living' }));
  const groups = [{ id: 'group-living', name: 'Living', is_income: false, hidden: false }];
  const client: ActualClient = {
    init: vi.fn(), shutdown: vi.fn(), sync: vi.fn(), loadBudget: vi.fn(), downloadBudget: vi.fn(),
    getBudgets: async () => [{ id: selectedBudget, groupId: selectedBudget, name: 'Merchant', state: 'remote', encrypted: false }],
    getServerVersion: async () => ({ version: '26.10.0' }),
    getAccounts: vi.fn(async () => accounts), getAccountBalance: async () => 0,
    getTransactions: vi.fn(async (id) => { beforeRead?.(); return rows.filter((row) => row.account === id); }),
    getPayees: vi.fn(async () => payees), getCategories: vi.fn(async () => categories),
    getCategoryGroups: async () => groups, getRules: vi.fn(async () => rules), getSchedules: async () => [],
    getBudgetMonths: async () => [], getBudgetMonth: vi.fn(), getTags: async () => [], runBankSync: vi.fn(),
    addTransactions: vi.fn(), createAccount: vi.fn(), updateTransaction: vi.fn(),
    createRule: vi.fn(), deleteRule: vi.fn(), setBudgetAmount: vi.fn(),
  };
  let connector: ActualConnector;
  const manager = new ConnectionManager({
    configPath: join(directory, 'config.json'),
    readFile: async () => JSON.stringify({ version: 1, serverUrl, budgetId: selectedBudget, budgetName: 'Merchant', groupId: selectedBudget }),
    writeFile: async () => {},
    credentialStore: { load: async () => ({ serverUrl, secretKey: 'synthetic-only' }), store: async () => {} },
    connectorFactory: async () => (connector = new ActualConnector({ client, cacheDir: join(directory, 'actual'), currency: options.currency ?? 'USD' })),
  });
  await store.claimBootstrap({ name: 'Holder', email: 'holder@example.test', claimId: 'claim' });
  await store.finalizeBootstrap({ claimId: 'claim', ownerUserId: 'holder' });
  await store.upsertActorMembership('holder', 'active', ['observe'], 'budget:budget-merchant');
  const space = store.governance.createSpace({ actorId: 'holder', name: 'Merchant', kind: 'shared', now, auth: humanAuth('holder') });
  store.governance.bindBudget({ spaceId: space.id, budgetId: 'budget-merchant', now, auth: humanAuth('holder') });
  const membership = store.governance.getCurrentMembership({ actorId: 'holder', spaceId: space.id, now });
  const policy = store.governance.getPolicy({ spaceId: space.id });
  if (!membership || !policy) throw new Error('Canonical governance fixture requires current membership/policy');
  const actor: MerchantActor = { actorId: 'holder', spaceId: space.id, budgetId: 'budget-merchant', membershipId: membership.id, governancePolicyVersion: policy.version, now, auth: humanAuth('holder') };
  const grant = (kind: GovernanceResourceKind, id: string, capability: string, granted = true, target = actor, restrictions?: ResourceGrantRestrictions) => {
    store.governance.setResourceGrant({ spaceId: target.spaceId, actorId: target.actorId, budgetId: target.budgetId, membershipId: target.membershipId!, resourceKind: kind, resourceId: id, capability, granted, restrictions, now: clockNow, auth: humanAuth('holder', clockNow) });
  };
  const grantSources = (target = actor, admittedRows = rows) => {
    for (const capability of ['observe', 'merchant:analyze', 'merchant:confirm', 'merchant:export', 'merchant:delete', 'lifecycle:delete', 'policy', 'rule:view','source']) grant('budget', actor.budgetId, capability, true, target);
    for (const capability of ['policy:manage', 'space:manage']) grant('space', actor.spaceId, capability, true, target);
    for (const id of new Set(admittedRows.map((row) => row.account!)))
      for (const capability of ['existence', 'name', 'history', 'source', 'merchant:confirm', 'policy']) grant('account', id, capability, true, target);
    for (const category of categories)
      for (const capability of ['existence', 'name']) grant('category', category.id, capability, true, target);
    for (const row of admittedRows) {
      for (const capability of ['transaction.view', 'source']) grant('transaction', row.id, capability, true, target);
      for (const capability of ['evidence', 'normalized-evidence', 'source', 'merchant:confirm', 'merchant:export', 'merchant:delete']) grant('evidence', evidenceKey(row.id), capability, true, target);
    }
  };
  grantSources();
  const service = new MerchantIntelligenceService({ store, connectionManager: manager, native, clock: () => new Date(clockNow), ...options });
  const addMember = async (id: string) => {
    await store.upsertActorMembership(id, 'active', ['observe'], 'budget:budget-merchant');
    const member = store.governance.addMembership({ spaceId: actor.spaceId, actorId: id, validFrom: clockNow, now: clockNow, auth: humanAuth('holder', clockNow) });
    return { ...actor, actorId: id, membershipId: member.id, auth: humanAuth(id, clockNow) } satisfies MerchantActor;
  };
  const admitPatternGrants = () => {
    const source = normalizeActualMerchantSource({ capturedAt: clockNow, expiresAt: '2026-10-05T12:00:00.000Z', currency: options.currency ?? 'USD', accounts,
      transactions: [...new Set(rows.map((row) => row.account))].map((id) => ({ accountId: id, startDate: '2021-10-04', endDate: '2026-10-04', read: { state: 'complete' as const, items: rows.filter((row) => row.account === id) } })),
      payees: { state: 'complete', items: payees }, categories: { state: 'complete', items: categories }, categoryGroups: groups,
      rules: { state: 'complete', items: rules }, schedules: { state: 'complete', items: [] },
      admission: { visibilityHash: 'fixture-pattern-admission', accountIds: [...new Set(rows.map((row) => row.account))], categoryIds: categories.map((category) => category.id), transactionIds: null },
      startDate: '2021-10-04', endDate: '2026-10-04', maxTransactions: 250_000 });
    const request = { ...canonical, transactions:source.transactions,payees:source.payees,categories:source.categories,rules:source.rules,schedules:source.schedules,sourceAdmission:source.sourceAdmission, scope: { spaceId: actor.spaceId, budgetId: actor.budgetId, connectionId: merchantConnectionId({ serverUrl, budgetId: selectedBudget }) }, asOfDate: '2026-10-04', aliases: [], corrections: [], patternDecisions: [], calendars: [], suggestionSelection: { transactionIds: [candidateId], cursor: null, limit: 200 } };
    const result = merchantAnalysisResultSchema.parse(JSON.parse(native.analyzeMerchantIntelligence(JSON.stringify(request))));
    for (const pattern of result.recurrences)
      for (const capability of ['evidence', 'normalized-evidence', 'source', 'merchant:confirm', 'merchant:export', 'merchant:delete']) grant('evidence', `merchant:pattern:${pattern.id}`, capability);
    return result;
  };
  return {
    store, databasePath, manager, service, actor, client, grant, grantSources, addMember, admitPatternGrants,
    rows: () => rows, setRows: (next: TransactionEntity[]) => { rows = next; },
    setRules: (next: RuleEntity[]) => { rules = next; },
    setClock: (next: string) => { clockNow = next; }, clock: () => clockNow,
    setConfig: (url: string, budget = actor.budgetId) => { serverUrl = url; selectedBudget = budget; },
    onRead: (callback: (() => void) | null) => { beforeRead = callback; },
    connector: () => connector!,
    cleanup: async () => { await manager.disconnect(); store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

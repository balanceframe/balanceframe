/**
 * @balanceframe/actual-adapter — Actual Budget API gateway
 *
 * Provides typed contracts for BudgetLedger, Observe-only capability reports,
 * server/budget discovery, isolated cache lifecycle, sync watermarks,
 * entity normalization into the protocol snapshot shape, health/compatibility
 * reporting, encrypted credential storage, and disconnect cleanup.
 *
 * ## Usage
 *
 * ```ts
 * import { ActualConnector, createDefaultActualClient } from '@balanceframe/actual-adapter';
 * import { EncryptedCredentialStore } from '@balanceframe/actual-adapter/credentials';
 *
 * const connector = new ActualConnector({
 *   client: createDefaultActualClient(),
 *   credentialStore: new EncryptedCredentialStore(),
 * });
 *
 * const budgets = await connector.connect({
 *   serverUrl: 'http://localhost:5006',
 *   secretKey: 'my-secret',
 * });
 *
 * await connector.selectBudget(budgets[0].id);
 * const snapshot = await connector.synchronize();
 * console.log(snapshot.health.state);
 * await connector.disconnect();
 * ```
 */

export type {
  BudgetLedger,
  LedgerCapabilities,
  ConnectionMode,
  LedgerId,
  AccountQuery,
  TransactionQuery,
  ImportTransaction,
  ImportOptions,
  ImportResult,
  TransactionPatch,
  MutationPrecondition,
  MutationResult,
  AutomationRule,
  RuleProposal,
  BudgetInfo,
  HealthReport,
  HealthState,
  Freshness,
  Coverage,
  Incident,
  CompatibilityResult,
  SyncWatermark,
  WatermarkStore,
  CacheState,
  LedgerSnapshotResult,
  VersionRange,
} from './types.js';
export {
  DEFAULT_MODE,
  DEFAULT_OVERLAP_DAYS,
  BROAD_ACCESS_CAVEAT,
} from './types.js';

export type { ActualClient, ActualConnectorConfig } from './connector.js';
export { ActualConnector, createDefaultActualClient } from './connector.js';

export type { CredentialStore, ActualCredentials } from './credentials.js';
export {
  EncryptedCredentialStore,
  EnvCredentialStore,
  NullCredentialStore,
} from './credentials.js';

export {
  normalizeAccount,
  normalizeAccounts,
  normalizeTransaction,
  normalizeTransactions,
  normalizeCategory,
  normalizeCategories,
  normalizePayee,
  normalizePayees,
  normalizeRule,
  normalizeRules,
  normalizeSchedule,
  normalizeSchedules,
  normalizeBudgetCategory,
  normalizeBudgetMonth,
  normalizeTag,
  integerToMoney,
  buildPayeeNameMap,
  buildCategoryInfoMap,
} from './normalizer.js';

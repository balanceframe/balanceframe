/**
 * Shared types for the rule API routes.
 *
 * Mirrors the shapes from @balanceframe/application's commands.ts and
 * @balanceframe/actual-adapter's types.ts without introducing a hard
 * dependency on either package at the web tier.
 */

/** Structured result from a rule mutation operation. */
export type RuleOperationResult =
  | { success: true }
  | { success: false; error: string; code: string };

/** List item for rule listing. */
export interface RuleListItem {
  readonly id: string;
  readonly name: string;
  readonly order: number;
  inactive: boolean;
  /** Set to true when `inactive` comes from a local override rather than Actual state. */
  _localOverride?: boolean;
}

/** Detail view of a single rule. */
export interface RuleShowResult {
  readonly id: string;
  readonly name: string;
  readonly order: number;
  readonly trigger: unknown;
  readonly actions: unknown;
  inactive: boolean;
  /** Set to true when `inactive` comes from a local override rather than Actual state. */
  _localOverride?: boolean;
}

/**
 * Minimal ledger contract for rule operations.
 *
 * Injected at runtime by the lifecycle plugin that manages the connection
 * to the Actual Budget ledger.  When absent the API routes return a
 * LEDGER_UNAVAILABLE error.
 *
 * Methods return `RuleOperationResult` so callers can distinguish actual
 * success from structured error codes rather than relying on bare booleans.
 */
export interface LedgerHandle {
  /** List every automation rule from the ledger. */
  listRules(): Promise<RuleListItem[]>;
  /** Update an existing automation rule. */
  updateRule(id: string, fields: Record<string, unknown>): Promise<RuleOperationResult>;
  /** Delete an automation rule. */
  deleteRule(id: string): Promise<RuleOperationResult>;
  /** Re-synchronise the ledger after a write to verify the new state. */
  synchronize(): Promise<unknown>;
}

/**
 * Extract the active ledger handle from the event context, or null when
 * no ledger is connected.
 *
 * The ledger is injected into `event.context.ledger` by the lifecycle
 * plugin that initialises the Actual-adapter connector.
 */
export function getLedgerFromEvent(
  event: { readonly context: Record<string, unknown> },
): LedgerHandle | null {
  const maybe = event.context.ledger;
  if (maybe && typeof (maybe as LedgerHandle).listRules === 'function') {
    return maybe as LedgerHandle;
  }
  return null;
}

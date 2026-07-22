/**
 * Shared types for the rule API routes.
 *
 * Mirrors the shapes from @balanceframe/application's commands.ts and
 * @balanceframe/actual-adapter's types.ts without introducing a hard
 * dependency on either package at the web tier.
 */

/** List item for rule listing. */
export interface RuleListItem {
  readonly id: string;
  readonly name: string;
  readonly order: number;
  readonly inactive: boolean;
}

/** Detail view of a single rule. */
export interface RuleShowResult {
  readonly id: string;
  readonly name: string;
  readonly order: number;
  readonly trigger: unknown;
  readonly actions: unknown;
  readonly inactive: boolean;
}

/**
 * Minimal ledger contract for rule operations.
 *
 * Injected at runtime by the lifecycle plugin that manages the connection
 * to the Actual Budget ledger.  When absent the API routes return a
 * LEDGER_UNAVAILABLE error.
 */
export interface LedgerHandle {
  /** List every automation rule from the ledger. */
  listRules(): Promise<RuleListItem[]>;
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

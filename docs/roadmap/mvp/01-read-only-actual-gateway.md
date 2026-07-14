# Phase 1 — Read-only Actual gateway

**Depends on:** Phase 0  
**Status:** Upcoming

## Objective

Connect an existing user-selected Actual server and budget in **Observe** mode, normalize it into the Rust protocol, and return trustworthy deterministic findings before requesting model configuration or write authority.

Users must not need a new Actual instance, new budget, forced migration, public exposure of their server, or broad write credentials. Existing history, categories, schedules, rules, reconciliation, bank links, and reports remain in Actual.

## Deliverables

### Connection lifecycle and status

1. Enter/discover Actual server URL; authenticate using the least-privileged available Actual identity; list/select budget.
2. Download each budget into an isolated application-managed cache and manage one coordinated API lifecycle plus one serialized mutation stream per cache, even though this phase prohibits writes.
3. Display server version, budget identity, encryption state, compatibility/capabilities, access mode, connection health, last download/sync, last bank sync when available, account coverage, and current incidents.
4. Encrypt credentials at rest; support environment/secret-file injection, rotation, and deletion; never log or send Actual/E2E credentials to model providers.
5. Disconnect by deleting application cache and credentials without changing Actual. Project-side filtering never reduces the connector's own broad Actual access; surface that limitation.

Authentication is not proof that facts are complete or current. Persist cursors/watermarks and safely reprocess overlap; do not assume webhooks or a complete event stream.

### Connection access modes

The connection access mode governs what BalanceFrame may do with a connected Actual budget. Observe is the only mode enabled in this phase.

- **Observe** (default onboarding mode): connect, download, synchronize, and analyze; produce suggestions in the project database; never modify Actual; never run bank sync unless independently enabled; never create categories or rules.
- **Review and apply** (Phase 4): suggestions remain durable proposals; only explicit approved categorizations are applied; no automatic categories, rules, or budget reallocations; each write has authorization, precondition, idempotency, and audit evidence.
- **Managed automation** (post-MVP): configured low-risk deterministic actions may be applied; bank sync may run on a configured schedule; reviewed rules may be created; consequential budget changes remain separately controlled.
- **Disposable sandbox** (optional safety mode): export an Actual budget; load it into a separate disposable Actual instance or isolated budget; disable or remove bank-sync credentials; freely test mutations; do not automatically merge sandbox changes into production. A sandbox is useful for behavioral evaluation but is not the normal onboarding path.

### Ledger port

Define a capability-aware internal interface rather than pretending all future backends implement the same behavior identically:

```ts
interface BudgetLedger {
  capabilities(): Promise<LedgerCapabilities>;
  synchronize(): Promise<LedgerSnapshot>;

  listAccounts(query: AccountQuery): Promise<Account[]>;
  listTransactions(query: TransactionQuery): Promise<Transaction[]>;
  listCategories(): Promise<Category[]>;
  listPayees(): Promise<Payee[]>;
  listRules(): Promise<AutomationRule[]>;
  listSchedules(): Promise<Schedule[]>;

  importTransactions(
    accountId: LedgerId,
    transactions: ImportTransaction[],
    options: ImportOptions,
  ): Promise<ImportResult>;

  updateTransaction(
    transactionId: LedgerId,
    patch: TransactionPatch,
    precondition: MutationPrecondition,
  ): Promise<MutationResult>;

  createRule(
    proposal: RuleProposal,
    precondition: MutationPrecondition,
  ): Promise<MutationResult>;

  setBudgetAmount(
    month: BudgetMonth,
    categoryId: LedgerId,
    amount: Money,
    precondition: MutationPrecondition,
  ): Promise<MutationResult>;
}
```

The adapter normalizes Actual objects into stable project types. Stable Actual IDs are retained as backend references. Category names are display values, never canonical policy keys.

### Connector security and compatibility

A user-supplied Actual instance may be old, new, intermittent, behind a proxy, use a private CA, be encrypted, and be modified simultaneously by other clients. Authentication success alone does not mean the connection is healthy or supported.

The connector must maintain: supported version range; capability report; compatibility result; health state; last successful download/sync; last bank sync if available; isolated local cache; encrypted credential storage; and explicit read/write mode.

Never expose Actual publicly merely to connect a hosted service. A future hosted offering should prefer a user-initiated outbound connector, private tunnel, or local bridge.

### Onboarding elevation

Elevation from Observe mode through any write capability is an explicit capability change, not a default. Before the first mutation, offer and verify a backup. The initial read-only connection must produce value before requesting write access or model-provider configuration. The first read-only assessment should identify applicable findings such as: uncategorized backlog size and age; repeated merchant candidates; likely deterministic rules; possible duplicates; stale or unhealthy connections; material uncategorized totals; recurring-charge candidates; and categories with repeated historical corrections.

Show exactly what was scanned, its freshness, and what could not be inspected. Let the user review deterministic findings before enabling inference. Offer backup and disconnect as visible onboarding and lifecycle actions.

### Bank-sync credential caveat

Actual bank-sync credentials live on the Actual server and are not protected by Actual budget E2E encryption. Server and backup security must reflect that. Document that project-side data filtering does not reduce the broad access held by the connector itself.

### Concurrency and idempotency invariants

| Concern | Invariant |
|---|---|
| Actual lifecycle | One coordinated API lifecycle and serialized mutation stream per budget cache. |
| Polling | Persist a cursor/watermark and safely reprocess overlap. |
| Bank sync/classification | Only one active cycle per ledger budget unless proven safe otherwise. |
| Notification | Retrying after partial failure must not spam duplicates. |

The system must tolerate job retries, process crashes, sync failures, repeated provider responses, user changes in Actual between suggestion and approval, multiple application users reviewing simultaneously, stale local caches, and network partitions.

### Normalized deterministic analysis

- Read accounts, transactions, categories/groups, payees, rules, schedules, and needed budget state through TypeScript; normalize stable backend IDs into immutable protocol snapshots.
- Rust validates snapshots and produces checked-money results, data-quality/freshness/coverage/capability readiness, categorization eligibility, normalized merchants, exact historical evidence, and duplicate/reconciliation evidence.
- Return explicit reason codes and blockers for stale snapshot/bank sync, missing expected accounts, pending/uncleared policy, material uncategorized exposure, imports, duplicates, and unresolved metadata references.
- Label every result with snapshot freshness, bank-sync freshness where known, selected accounts, dates, pending/transfer/split/exclusion policy, and inclusion scope. Every aggregate must drill down to its source Actual records and filters.
- Produce useful no-model onboarding findings: uncategorized backlog size/age/amount, repeated merchants, deterministic classifications, likely rule candidates, possible duplicates, recurring-charge candidates, stale connections, and repeated historical corrections.

### Interfaces and supported use

- Add stable versioned JSON CLI results, including request ID, schema version, freshness, authorization context, result/error, and reason codes. This CLI is BalanceFrame's external automation interface; internal integration remains direct API use.
- Provide manual/no-model paths, documented metadata export, and smoke tests for export/disconnect/removal.
- Keep responsive web/CLI output semantics aligned as later UI work begins. Do not calculate Rust-owned values independently in either surface.

#### CLI shape

```bash
balanceframe transactions pending-review --json
balanceframe reviews show REVIEW_ID --json
balanceframe budget summary --json
```

#### JSON envelope

```json
{
  "schemaVersion": "1",
  "requestId": "req_...",
  "status": "ok",
  "dataFreshness": {
    "actualDownloadedAt": "2026-07-12T15:04:00Z",
    "bankSyncedAt": "2026-07-12T14:58:00Z",
    "pendingTransactionsIncluded": true
  },
  "authorization": {
    "actorId": "usr_...",
    "capability": "classification.approve",
    "allowed": true
  },
  "result": {}
}
```

CLI schemas are stable, versioned contracts. Never expose `balanceframe actual raw-query`, `balanceframe invoke-method`, or `balanceframe shell`.

## Explicit non-goals

No Actual writes, bank-sync scheduling, automatic categories/rules, model-provider invocation, generic chat, custom Actual UI, or secondary attention queues. Do not present a healthy connection when recent cleared transactions or expected accounts are absent.

## Tests

Exercise encrypted budgets, sync interruption, old/new supported versions, private CA/proxy/intermittent conditions, external concurrent edits, stale caches, missing accounts, pending policies, duplicate evidence, and no-model operation. Direct Rust fixture results and Node-binding results must match.

## Exit

**The JSON CLI correctly lists categorized and unresolved candidates, health/freshness/coverage, and blockers without modifying Actual.**
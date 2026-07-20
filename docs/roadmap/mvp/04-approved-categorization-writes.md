# Phase 4 — Approved categorization writes

**Depends on:** Phase 3  
**Status:** Upcoming

## Objective

Apply only an exact, authorized, current, approved categorization proposal to Actual. An API success response alone never completes the workflow.

## Mutation pipeline

```text
typed human request or model-derived proposal
→ deterministic authorization and policy disposition
→ required human approval for the exact payload
→ latest Actual snapshot
→ Rust immutable plan and canonical hash
→ TypeScript Actual write
→ Actual re-read
→ Rust postcondition verification
→ workflow completion and audit
```

The MVP policy always yields `approval_required` for model-derived ledger changes. `authorized_without_approval` exists in the protocol only for future separately authorized deterministic/delegated actions and is not enabled here.
## Web application boundary

The responsive web application is implemented with **Vue 3 and Nuxt 4**, using the latest **Nuxt UI v4** component library. Nuxt is the presentation/runtime shell, not a financial or authorization authority. The authenticated operational application is client-rendered initially (`ssr: false`); Nuxt/Nitro runs as the Node application server and exposes only narrow authenticated query/command endpoints.

- Adapt the existing framework-neutral `ReviewController` and shared application services rather than replacing or duplicating their state machines in Vue, Pinia, or components.
- Keep the browser UI as a thin presentation adapter over immutable state and typed results. Keyboard, touch, CLI, and web actions must use the same capability-layer semantics and versioned contracts.
- Server routes authenticate and validate transport requests, then call the TypeScript application layer. They must not expose Actual credentials, raw Actual methods, N-API calls, or alternate mutation paths.
- Display exact proposal details, payload hash, policy version, expiry, provenance, correlation ID, and classified recovery state. The UI must never treat an API acknowledgement as verified completion.
- Nuxt UI components must make approval, stale, unauthorized, superseded, failed, recovering, and verified-applied states distinct and accessible; component defaults never replace server authorization or policy decisions.

WebAssembly is not a Phase 4 execution path. Future Wasm 3.0 work is limited to pure Rust, read-only, non-authoritative local previews or offline analysis over immutable snapshots. Browser Wasm must never execute Actual writes, approvals, authorization, audit mutations, or postcondition authority.

Reference: [Nuxt UI v4](https://ui.nuxt.com/docs/getting-started).


## Deliverables

### Exact proposals and authorization

- Create immutable proposals with initiating actor/origin, operation, stable target IDs, exact payload hash, policy version, preconditions, expiry, provider/model/prompt provenance where relevant, and correlation ID.
- Bind approvals to a displayed, unexpired exact proposal. Changed category, amount, target, or action creates a new proposal; expired, superseded, consumed, payload-mismatched, inactive-member, unauthorized, or insufficient-capability approvals cannot execute.
- Evaluate actor identity, active membership, capability, scope/threshold, exact payload, current policy, snapshot/data-quality gates, and state deterministically. Do not infer permissions or approval sufficiency from conversation.

### Rust plan and Actual execution

- Obtain a latest normalized Actual snapshot. Rust validates records/current version and returns a narrow immutable `set category` plan with canonical payload hash and expected state preconditions.
- TypeScript executes only that plan through `@actual-app/api`, with a per-write idempotency key and the per-budget serialized stream; then re-reads Actual.
- Rust verifies the intended postcondition before workflow completion. If Actual changed after approval, reject stale planning/preconditions. If Actual committed but the process crashed before recording success, reconcile with plan ID, idempotency key, latest state, and postcondition—not by blindly repeating the write.
- Record resulting state, classified failure, and recovery result. Preserve one active suggestion identity across retries and concurrent reviews.

### Audit and lifecycle safety

Audit records include event/timestamp, actor/auth context, space/connection, operation, exact backend IDs, proposal/hash, policy version, authorization disposition, idempotency key, expected/observed prior/resulting state, provider provenance, result/error, and request ID. Initial controls are application-only database access, no audit update/delete methods, history-preserving migrations, encrypted backups, restore tests, and documented retention/deletion. Do not claim tamper-proof audit without a threat-model-supported cryptographic design.

Offer/verify a backup before first mutation. Restore must not replay queued writes, resurrect consumed approvals, or hide unresolved ledger references.

### Backup model

Back up separately:

1. Actual financial data;
2. project SQLite metadata, approvals, provenance, alert state, and shared records;
3. version-controlled configuration;
4. encrypted secrets through a separate secret backup process.

Restore tests must verify:

- Actual opens and synchronizes;
- project database migrations succeed;
- ledger references resolve or fail visibly;
- queued writes do not replay accidentally;
- approvals remain correctly consumed/expired;
- CLI and UI can query the restored state.

### Export, deletion, and removal lifecycle

BalanceFrame owns its workflow, proposal, approval, audit, provider, notification, policy, and connector metadata; Actual owns ledger records. Support three distinct, explicit operations:

1. **Disconnect:** remove the selected connection's application cache and credentials without changing Actual. Retain only project records whose documented lifecycle requires them.
2. **Scoped project-data deletion:** delete the selected BalanceFrame-owned connection, space, user, provider, workflow, or notification data scope without modifying Actual. This is not an implicit consequence of disconnecting.
3. **Complete application removal:** remove all BalanceFrame-owned data and credentials from a self-hosted deployment after the operator has exported the desired metadata and completed any policy-required retention handling. Actual remains independently usable before, during, and after removal.

Before a scoped deletion or complete removal, provide an inventory of affected records, an export opportunity, the exact scope, all shared/audit records that cannot yet be deleted, their retention policy and reason, and the effect on active connections, memberships, delegations, sessions, notification destinations, queued jobs, and backups. Require a re-authenticated actor with the applicable deterministic capability and explicit confirmation of that exact scope.

At execution, stop or cancel affected jobs; prevent queued mutations and notifications from replaying; revoke affected credentials, sessions, delegated authority, provider access, and verified messaging destinations; delete application caches and eligible metadata; and record a minimal lifecycle audit result. Never alter Actual accounts, transactions, rules, budgets, bank credentials, or server data. Re-read no ledger data solely to perform deletion.

Deletion cannot retroactively erase data from an already-created encrypted backup without a separate backup-retention process. Disclose that limitation, the backup location/class, and its scheduled retention/expiry instead of claiming immediate erasure. Linked-space data follows its shared-record retention policy and must be handled through the linked-space lifecycle, not silently removed from other participants.

Expose stable CLI and responsive-web results for each lifecycle operation. Results identify the actor, scope, records deleted/retained, retention reasons, credential/delegation revocations, cancelled work, backup-retention status, Actual non-mutation confirmation, correlation ID, and failures.

### Deployment and failure independence

Initial self-hosted deployment target: one Actual container or user-supplied Actual server; one project application container; one project data volume; one Actual data volume when bundled; optional local model container; one configuration source or guided setup; built-in health checks and migrations; no broker, Kubernetes, fork, Git submodule, or microservice fleet.

Failure independence:

- Actual remains usable if the project is down.
- Failed inference does not block imports or manual budgeting.
- A corrupt project metadata store does not corrupt Actual.
- Disconnecting the project does not delete Actual records.
- Project metadata is exportable.

### Concurrency invariants for mutations

| Concern | Invariant |
|---|---|
| Mutation | Every write has an idempotency key and expected state precondition. |
| Approval | Expired, superseded, consumed, or payload-mismatched approval cannot execute. |
| Notification | Retrying after partial failure must not spam duplicates. |
| Reallocation | Donor balances are re-evaluated immediately before execution (post-MVP). |

## Tests

Unauthorized visibility/action; inactive membership; insufficient scope; approval expiry/payload mismatch/replay; stale snapshot; external Actual edit; concurrent reviewers; duplicate delivery; partial crash; postcondition mismatch; encrypted backup/restore; and TypeScript bypass attempts around Rust planning.
Deletion tests: unauthorized or stale confirmation; export-before-delete; exact-scope confirmation; disconnect versus scoped deletion versus complete removal; Actual non-mutation; queued-write and notification suppression; credential/session/delegation/destination revocation; retained audit/shared records with visible reasons; encrypted-backup retention disclosure; partial crash recovery; and web/CLI result parity.

## Exit

**Stale, replayed, conflicting, or unauthorized changes cannot silently alter Actual, and every completed write has a verified postcondition and audit evidence.**
# ADR 0003: Space-scoped authority and exact collaborative approval

**Status:** Accepted

## Context

An Actual server connection supplies ledger access, not BalanceFrame collaboration policy. Independent people and delegated agents must share decisions without automatically sharing credentials, private source data, or control of the ledger. An approval of a total cannot authorize undisclosed composite operations.

## Decision

- A personal or shared Space is the authorization boundary. Selection is explicit and binds the request to one budget; relationship labels carry no authority. Better Auth establishes identity, while the workflow store determines current membership, exact grants, and delegation authority.
- Scoped rule updates/deletions use a dedicated Native baseline-inspection admission before the SDK is opened. It checks current exact budget/rule proposing rights, principal/delegation, named operation, visibility, and one-operation limits, but grants no mutation or raw-read authority. Only the unavailable rule matching scope is deferred: the privately retrieved authoritative snapshot must pass unchanged complete proposal authorization before persistence or disclosure. This avoids a second, potentially stale rule cache and does not weaken ordinary authorization.
- Memberships are retained, non-overlapping, half-open time periods. Revocation removes future access but retains attribution. Rejoining creates a new period and does not inherit approvals, saved private references, or grants from the former period.
- The existing SQLite workflow store owns versioned governance policy and exact resource grants. Authorization evaluates complete resource and operation facts, including account/category bounds, aggregate-only and proposal-only visibility, operation allowlists, gross outgoing amounts, and counts. Financial policy remains a distinct versioned input.
- Proposing, approving, and executing remain separate capabilities. Exact canonical proposals bind all base and composite operations, source references, amounts, preconditions, requester membership, expiry, and policy versions. Current distinct human approvals satisfy the current quorum. Native execution acquisition atomically rechecks authority and binds approval consumption, idempotency, and attributable audit. Renewing authentication proof does not alter the financial command identity.
- Agent credentials identify a registered principal and live versioned delegation; effective authority cannot exceed the issuer's current membership and grants. Control-plane operations, approvals, and settlement remain freshly reauthenticated human actions. Model output cannot establish identity, permission, approval, or financial correctness.
- Sensitive fields have independent grants. Server-side financial evaluation may use private inputs, but the public projection checks the complete contributing closure before releasing a redacted conclusion. A conclusion grant does not authorize raw source records, balances, account names, documents, or model egress. Cached findings are reauthorized against current durable intent rather than trusted as financial evidence.
- Read admission and writes retain actual principal, membership/delegation attribution, selected scope, policy, and request correlation. Audit projections have their own scoped permissions and do not expose raw private result details. Notifications bind the intended recipient membership and recheck current authorization and redaction at dispatch.
- Actual SDK access remains serialized by its existing process-wide lifecycle lock. Selected-budget validation happens inside that lock before owner cleanup, credentials, or SDK access. Scoped disconnect/removal cannot tear down a different budget's active connection. Export and data lifecycle controls require current human proof; deletion requires a verified export in the same scope and preserves historical attribution.

## Consequences

There is one deterministic governance system, not a separate agent or role-based bypass. Source APIs and the CLI consume it; neither caller-supplied actor IDs nor an instance-owner label supply financial authority. Legacy whole-ledger reads require explicit unrestricted resource-visible budget authority and fail closed for aggregate-only or narrowed grants.

The existing workflow schema migrations and canonical proposal path are reused rather than adding a second ledger, shared account credentials, or a parallel approval service. Existing data without current governance provenance is not silently treated as approved. Financial actions remain unavailable when current scope, exact facts, policy, or data-quality gates cannot be established.

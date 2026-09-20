# @balanceframe/application

Application orchestration layer.

Coordinates classification, workflow management, and persistence operations.

## Account-aware spendability

`LiquidityService` is the injected application boundary for current account capacity,
category backing, purchase checks, cash-neutral reallocation previews, manual Spend
Sessions, approved category payment preferences, and the manual transfer workflow.
It reuses `ConnectionManager`, `WorkflowStore.liquidity`, the native JSON methods,
and a trusted clock. Rust performs all financial calculations and transfer verification.
The existing purchase HTTP and production CLI paths use this service; funding and
payment readiness remain independent, and legacy `allowable` is true only when the
category is funded **and** the selected account is ready.

Public request schemas and DTOs are exported from the package root. Requests contain
intent only: no actor identity, claims, canonical plans, callbacks, raw import evidence,
policy hashes, or observation provenance. `LiquidityProjector` allowlists results
against current membership and capability × resource grants. A conclusion grant is
not an account-visibility, balance, transfer-source, approval, or initiation grant.
The separate budget-only `full-read` grant permits legacy whole-budget disclosures;
it does not confer transfer authority.
Observation configuration is an explicit allowlist: policy authority alone does not
disclose balances, history, or nested account/category references. Whole-document
replacement requires policy authority over both existing and submitted resources.
Finding and notification pages apply selected-budget and current resource visibility
before public pagination; hidden records never consume visible page positions.

Actual ledger balances are authoritative. Governed manual observations are explicitly
user-attested and time-bounded. The adapter binds `currentLedgerConfirmed` to the
original raw ledger material before persistence; unchanged recapture remains valid,
while changed material makes that account's old observation unavailable until it is
reconfirmed. Missing policy or evidence leaves catalog/setup usable, never marks cash
ready, and never silently renews a confirmation.
A precise trusted global account-collection receipt can establish enumeration completeness
despite partial account metadata; it never supplies missing bank facts.

Transfer preview stores the exact native plan without creating a proposal or claim.
Proposal admission loads that original preview, rechecks material native preconditions
inside the store's IMMEDIATE transaction, and atomically holds source claims.
The original plan anchors the verification horizon while evaluation time remains current.
Trusted captures dispatch workflow expiry before loading the evaluation claim set.
Approvals and instructions use the same trusted clock and current grants. Reporting
initiation is an acknowledgement, not bank settlement. Only trusted imported evidence
verified by Rust can replace/release in-flight effects; unavailable/ambiguous evidence
retains the hold. Existing Review Sync, liquidity reads, and attention reconcile active
transfers and use the existing finding/notification lifecycle, not a transfer inbox.
Instructions persist adverse native revalidation before external action. An authorized
report records an already initiated manual transfer conservatively when ledger data has
changed: financial mismatches are diagnostic, not permission to erase the in-flight hold.
Captured imported proof may reconcile immediately afterward; acknowledgement alone never settles.

Manual Spend Sessions are jointly evaluated **UNRESERVED** carts. Session edits and
cancellation invalidate linked uninitiated plans; initiated holds survive until proof.
Category reallocations change category demand only and do not move bank cash.
Purchase times may be omitted for immediate intent; the service resolves them only at
the trusted post-synchronization capture. Explicit times and stored session times remain
unchanged, and the exclusive horizon ends strictly after every required instant.
Persisting a transfer preview requires explicit future purchase instants for every item
in its immutable scenario; immediate checks retain read-only transfer conclusions.

### Public HTTP intents

All success responses retain the existing envelope and contain the exported public DTO
in `result`. All monetary values are decimal minor-unit strings with currency.

- `GET /api/liquidity/spendability`
- `GET /api/purchase/evaluate?categoryId=food&amount=2000&currency=USD&accountId=checking`
- `POST /api/liquidity/reallocation-preview` with `{moves:[{id,sourceCategoryId,destinationCategoryId,amount}]}`
- `GET/PUT /api/liquidity/policy`; `PUT /api/liquidity/observations`
- `GET/PUT /api/liquidity/grants`; `GET/PUT /api/liquidity/preferences`
- `POST /api/spend-sessions`; `GET/PUT/DELETE /api/spend-sessions/:id`
- `POST /api/transfer/preview` with a purchase intent or `{kind:"session",sessionId,expectedSessionVersion,purchaseItemId}`
- `POST /api/transfer/propose` with `{previewId,payloadHash,idempotencyKey}`
- `GET /api/transfer/:id`
- `POST /api/transfer/:id/approve|instructions|report-initiated|reconcile|cancel`
  with `{payloadHash,expectedVersion,idempotencyKey}`

Preference writes use `{categoryId,accountId,expectedVersion,expiresAt}` (`0` for a
new preference). Stable preference IDs and approval provenance are server-generated.
Route precedence is explicit account, session account, approved preference, authorized
deterministic history, then alternatives.

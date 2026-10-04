# Phase 7 — Space governance

**Depends on:** MVP write/audit path  
**Status:** Implemented and verified

## Objective

Introduce controlled collaboration without shared credentials or automatic private-data disclosure. A **Space** is the neutral top-level collaboration, policy, and authorization boundary; use “budget space” in product copy when context is needed.

A space may be personal or shared-ledger now and linked later. Relationship labels such as spouse/family are presentation labels, not authorization primitives.

## Deliverables

### Identities, memberships, and capability policy

- Add independent users, personal/shared spaces, temporal memberships (`validFrom`, `validUntil`), membership history, session/authentication context, notification privacy, and audit visibility.
- Add deterministic capabilities such as summary/transaction view, classify/review/approve, category/rule creation, affordability evaluation, reallocation proposal/approval/execution, membership/policy management, and audit view.
- Scope grants by space, selected accounts/categories, aggregate-only visibility, operation type, proposal-only rights, thresholds, and amount/count limits. Separate proposing, approving, and executing; support thresholds and multiple required approvers.
- Compute authorization from authenticated human or AI-agent identity, active membership/unrevoked delegation, capability, resource/limits, exact payload, current state/data-quality gates, and current policy version. The model never infers any of these from conversation.
- Add resource-specific capabilities for purchase evaluation/session/reservation, commitments/scenarios, evidence ingest/view/resolve, wallet/receipt visibility, and transfer proposal/approval/confirmation. Scope sensitive account and evidence fields independently: account existence, name, balance, history, liquidity result, transfer-source identity, raw document, normalized evidence, and proposed ledger effect are distinct grants.
- Support authorized redacted conclusions. A member may learn that an exact transfer is needed, a shared reservation changes availability, or an evidence resolution needs review without receiving an unauthorized source-account balance, receipt, payment note, counterparty, or raw document.
- Bind approval to the complete canonical payload for composite actions, including every reallocation, transfer recommendation, ledger projection, evidence reference, and exact amount; approving a total alone never authorizes omitted operations or hidden data disclosure.

### Exact approval semantics

- Require a displayed exact operation and payload hash, required approvers, expiry, requester, policy version, and auditable result.
- Return exactly one disposition: `approval_required`, `authorized_without_approval`, or `denied` with reasons. Natural-language “approve it” must resolve only to an exact, current proposal; any changed payload requires fresh approval.
- Retain the MVP rule for model-derived ledger changes. Future no-per-operation approval is governed by Phase 9.5 and reuses this path; it is not a second agent authorization system.

### Collaboration/privacy contract

- Every person has an independent identity and attributable history. A departing member loses future access but retains historical identity/attribution; replacements receive new memberships and never inherit prior private references.
- Support shared-ledger spaces without asserting Actual authentication is sufficient for BalanceFrame visibility policy. Do not forward passwords/magic links, grant all members full control, rely on role labels without scopes, or copy private ledgers into shared spaces.
- Keep control-plane operations—identity, membership, grants/scopes, approvals, delegation policy, provider/egress, retention, backups, ledger connection, audit controls—human-controlled and re-authenticated.

## Tests and exit

Test unauthorized visibility, aggregate-only scope, independent account-balance/liquidity/transfer-source grants, raw-versus-normalized evidence access, redacted transfer/reservation/evidence conclusions, inactive/departed membership, insufficient capability, threshold/multi-approver rules, composite payload approval, expiry, consumed/replayed/mismatched approval, hidden data not sent to models, temporal history, revocation, notification redaction, and audit attribution.

**Exit:** every read and action is attributable, scoped, and deterministically enforced without collaboration depending on shared full-control credentials.

## Implementation and verification

- Native governance, current membership/delegation checks, scoped visibility, canonical
  approvals, and retained attribution live in `packages/workflow-store`. See
  [ADR 0003](../../adr/0003-space-governance-and-exact-authority.md).
- Source uses explicitly selected spaces and authenticated server-side authority.
  The CLI uses the same HTTP boundary; supplied actor IDs never select the caller.
- Regression coverage includes governance authorization/approval, temporal memberships,
  liquidity and evidence projections, notification dispatch, exact proposal routes,
  private-read admission, and scoped lifecycle controls.
- Live Source verification used the disposable **BalanceFrame Test Budget** at
  `http://127.0.0.1:3002`, with authentication bypass disabled and three independent
  Better Auth identities. A Whole Foods **-$22.00** correction from Uncategorized to
  Groceries displayed the exact payload/hash and required two approvers. One approval
  did not expose execution; two distinct, freshly reauthenticated humans enabled it.
  Execution was verified, the pending queue changed from 46 to 45 items, replay
  retained the verified result, and a separate Actual export confirmed the category.
- The actual CLI exercised authenticated export, notification-scope deletion,
  disconnect, and remove-connection. Export bytes matched the recorded SHA-256;
  disconnect retained configuration and remove-connection removed it. Browser error
  logs were empty. Temporary services and browser tabs were stopped and fixture
  environment configuration restored.
- A second canonical Actual fixture exercised `/connection` and `/liquidity/settings`
  in the Nuxt development app with authentication bypass disabled. Password-gated
  discovery succeeded. A fresh canonical fixture then verified that both `/spaces`
  and `/connection` leave budgets unselected and saving disabled until the user
  chooses **BalanceFrame Test Budget**; the explicit connection save returned 200.
  Policy, observation, and grant
  saves each obtained fresh proof; rejected password confirmation issued no
  observation write. The grant editor saved exactly one Checking Account balance
  grant instead of replaying unrelated governance rows. Confirmation fields cleared,
  the corrected page had no browser errors, and fixture processes and configuration
  were cleaned up.
- The disposable `coapproval-completion` demo at `http://127.0.0.1:3003` exercised
  explicit `CONFIRM` renewal for two independently authenticated fictional approvers.
  The exact **-$26.00** debit and **$13/$8/$5** splits retained the same payload hash
  through 0/2, 1/2, and 2/2 approvals. The scoped reviewers gained no execution
  control; the final state was **Approved — not executed**. Both proof and approval
  requests returned 200, browser errors were absent, and the owned demo was removed.
- Independent correctness and security reviews found no remaining findings after
  correction. The final live-browser fixes also received focused correctness review.
- Final integration coverage passed: Source **1,225**, workflow store **613**,
  scenario kit **93**, live Actual **102**, and protocol contracts **139** tests,
  with no failed or pending cases. The resumed coverage run retained reports only
  for unchanged packages and reran changed consumers. The unchanged enforcement
  gate passed every package and changed-source threshold; workspace line coverage
  was **89.36%**, financial core **95.52%**, core protocol **96.66%**, and Node
  binding **95.99%**. Source and scenario production builds also passed.

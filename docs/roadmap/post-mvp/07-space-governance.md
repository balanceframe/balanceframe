# Phase 7 — Space governance

**Depends on:** MVP write/audit path  
**Status:** Post-MVP

## Objective

Introduce controlled collaboration without shared credentials or automatic private-data disclosure. A **Space** is the neutral top-level collaboration, policy, and authorization boundary; use “budget space” in product copy when context is needed.

A space may be personal or shared-ledger now and linked later. Relationship labels such as spouse/family are presentation labels, not authorization primitives.

## Deliverables

### Identities, memberships, and capability policy

- Add independent users, personal/shared spaces, temporal memberships (`validFrom`, `validUntil`), membership history, session/authentication context, notification privacy, and audit visibility.
- Add deterministic capabilities such as summary/transaction view, classify/review/approve, category/rule creation, affordability evaluation, reallocation proposal/approval/execution, membership/policy management, and audit view.
- Scope grants by space, selected accounts/categories, aggregate-only visibility, operation type, proposal-only rights, thresholds, and amount/count limits. Separate proposing, approving, and executing; support thresholds and multiple required approvers.
- Compute authorization from authenticated human or AI-agent identity, active membership/unrevoked delegation, capability, resource/limits, exact payload, current state/data-quality gates, and current policy version. The model never infers any of these from conversation.

### Exact approval semantics

- Require a displayed exact operation and payload hash, required approvers, expiry, requester, policy version, and auditable result.
- Return exactly one disposition: `approval_required`, `authorized_without_approval`, or `denied` with reasons. Natural-language “approve it” must resolve only to an exact, current proposal; any changed payload requires fresh approval.
- Retain the MVP rule for model-derived ledger changes. Future no-per-operation approval is governed by Phase 9.5 and reuses this path; it is not a second agent authorization system.

### Collaboration/privacy contract

- Every person has an independent identity and attributable history. A departing member loses future access but retains historical identity/attribution; replacements receive new memberships and never inherit prior private references.
- Support shared-ledger spaces without asserting Actual authentication is sufficient for BalanceFrame visibility policy. Do not forward passwords/magic links, grant all members full control, rely on role labels without scopes, or copy private ledgers into shared spaces.
- Keep control-plane operations—identity, membership, grants/scopes, approvals, delegation policy, provider/egress, retention, backups, ledger connection, audit controls—human-controlled and re-authenticated.

## Tests and exit

Test unauthorized visibility, aggregate-only scope, inactive/departed membership, insufficient capability, threshold/multi-approver rules, expiry, consumed/replayed/mismatched approval, hidden data not sent to models, temporal history, revocation, notification redaction, and audit attribution.

**Exit:** every read and action is attributable, scoped, and deterministically enforced without collaboration depending on shared full-control credentials.
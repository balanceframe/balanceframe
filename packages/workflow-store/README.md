# @balanceframe/workflow-store

Workflow persistence (SQLite).

Manages categorization review workflows and state transitions in a local SQLite database.

## Complete native Review provenance

`createReviewItems({scope,nativeRuleBlocks,nativeRuleParts,nativeRuleSets,items,authorize})`
publishes complete native provenance, Review rows, and source supersessions in one
SQLite IMMEDIATE transaction. Blocks own globally disjoint, scalar-sorted rule IDs;
parts own literal block postings. Sets are constant-size descriptors:
`categoryPart ∩ (OR union ∪ intersection of four AND operand-unions)`, with fixed
AND positions payee ID/name, account ID and category ID. OR has at most four parts;
each AND operand has at most two. Empty AND means no contribution, not a wildcard.
Only used, nonempty sets are admitted, with at most thirteen parts per set.
Generic legacy ingestion adds no merchant-only count or ID-byte limit.
Native items use `ruleSetIndex`; evidence retains only a scoped `ruleSetRef`.
A final synchronous authority callback fences the whole batch.

Content-addressed `review_rule_blocks`, `review_rule_parts` and `review_rule_sets`
bind each layer to its attribution and space/budget/connection namespace.
Table permutation and unreferenced blocks/parts do not change set identity.
`getReviewRuleSetMetadata(id)` returns only immutable namespace metadata for bulk
admission; it does not parse postings or expand IDs. `getReviewRuleSet(ref)` expands
only one explicitly selected set, validating every selected content identity,
namespace and distinct-block duplicate ID. Overlap of the same block across literal
parts deduplicates. Neither lookup grants source/rule disclosure authorization;
collection persistence never expands sets.

Migration 25 preserves old inline IDs as explicit budget-only historical groups
and supersedes actionable unattributed Review rows with a resync reason. Appended
migration 26 upgrades retained v25 databases through one old group/Review row at a
time, retaining complete legacy lists as opaque blocks without inventing predicates.
Migration 27 uses the same indexed, one-row-at-a-time traversal to wrap each old v26
block list in one frozen literal part, used for both OR and category filtering.
It never infers historical categories, predicates or current-source facts.
Known scoped attribution remains known;
unattributed history remains unattributed. Every rewritten Review reference bumps
its optimistic version. Scoped revisions use the same canonical, row-specific
saved financial facts and target/reference binding as current publication, not a
set-wide old revision token. Missing or invalid saved source JSON retains its
opaque history without acquiring a financial source revision.
Previously captured approved proposal snapshots need fresh Sync/proposal capture,
not silent current-match authority. Present native `reviewSourceRevision` values
must exactly match persisted evidence; legacy source-less contracts remain intact.
Immutable proposal/approval/audit documents, terminal status and financial facts
are not rewritten or erased. Historical refs cannot reopen or authorize proposals.
Current native issue identity includes space/budget/connection. Workflow lifecycle
deletion owns all three selected provenance tables independently of merchant policy;
merchant opt-out/deletion and backup quarantine do not erase native evidence.


## Space governance

`store.governance` owns personal/shared spaces, half-open membership periods,
versioned policies, exact resource grants, bounded agent delegations, and credential
bindings. A space starts unbound; a separately authorized, freshly reauthenticated
human binds its Actual budget. An Actual connection does not grant financial visibility.

Authorization uses the authenticated principal, selected space and budget, current
membership period, current policy, complete resource closure, and actual operations.
Account/category restrictions, aggregate-only and proposal-only rights, gross outgoing
amounts, and operation counts are checked together; unrelated grants cannot be combined
to authorize an otherwise forbidden operation. Account existence, name, balance,
history, liquidity, and transfer-source identity are separate capabilities, as are raw
documents, normalized evidence, and proposed ledger effects.

Proposals bind the canonical payload and preconditions, requester membership,
financial policy, and governance policy. Composite actions bind every operation and
resource—not just the total. Approval requires the displayed hash and fresh human
authentication; acquisition rechecks current distinct approvers, expiry, current
authority, and exact idempotency identity atomically with approval consumption and
audit. Authentication-proof renewal does not change the financial command identity.

Revocation ends future access without deleting attribution. Rejoining creates a new
membership period; saved private references and approvals do not transfer to it.
Agent authority is the intersection of its live credential/delegation and the issuer's
current grants. Agents cannot receive human control, approval, or settlement authority.

Aggregate conclusions may depend on private financial inputs without disclosing them.
Projection must authorize the complete contributing resource/operation closure before
returning any global status. Summary admission never grants access to source documents,
transactions, rule details, or account fields.

## Liquidity action specialization

`store.liquidity` extends the shared action proposals, approvals, idempotency and audit
records with immutable transfer previews, versioned policy/observations/preferences,
manual Spend Sessions and atomic claim effects. Trusted validators run synchronously
inside SQLite IMMEDIATE transactions against the current independent claim revision.
Native verification owns financial effects; `claimEffects:null` retains existing holds
and only confirmed settlement may release them.

Prospective commitments and reservations use the same `liquidity_claims` rows
and revision as transfers. `saveProspectiveClaim` applies the versioned policy's
`reservationMode` (`block` by default, `inform` only when governed), not a
claimant-selected mode. Effective dates and expiry change financial inclusion
without deleting audit history; category/account effects of one obligation may
share an economic identity, but duplicate effects within a scope are rejected.
`transitionProspectiveClaim` requires current scope authority and verified,
budget-unique consumption evidence before releasing a consumed hold. Uncertain or
initiated effects are not released merely because a session is edited or expires.

`loadEvaluationState({actorId,budgetId,now})` returns sensitive server-only evaluation
inputs. It requires current effective conclusion membership and a granted resource,
not merely `observe`; application callers must separately authorize requested resources
and project every result. Expired supplemental records retain their version for editing
but must not be applied as current observations.
Payment preference management may request `includeExpired` to retain the version needed
for explicit CAS renewal; effective route selection excludes expired preferences.

`getTransferApprovalSummary` uses the application's trusted time without mutating
approvals through another clock. `cancelSpendSession` uses CAS/idempotency, preserves
session evidence and audit, and never releases initiated transfer holds.

Resource discovery provisions only explicitly authorized current membership grants;
it never replaces a revocation or restores a previous membership period's rights.
The budget `full-read` capability is explicit privileged whole-budget disclosure for
legacy financial endpoints, which also require current selected-space `observe`.
Aggregate-only or narrowed budget grants cannot authorize a whole raw ledger.
`full-read` does not imply proposal, approval, execution, settlement, or audit authority.

`getProposalApprovalReads` admits and returns current rows synchronously for a trusted
server projection; raw proposal payloads are not public DTOs. Authorize source/effect
facts independently for each row, then charge every emitted Money occurrence in the
requested `preconditions`, `envelope`, or `detail` projection. Financial resources use
whole-collection numeric ceilings; private evidence subjects retain their own local
ceilings and N+1 checks. Any eligible malformed or over-cap private envelope withholds
all private envelopes while preserving independently authorized metadata. Derived
balances count as Money slots but do not create ledger outgoing; incoming never nets
against outgoing. Construct the client view only after the last awaited operation.

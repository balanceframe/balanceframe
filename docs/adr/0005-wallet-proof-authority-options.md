# Wallet statement authority and nonzero opening balances

Status: accepted for implementation and synthetic tests on 2026-10-21. Live
financial changes, packages and external integrations remain unauthorized.

The Phase 11.5 resolver can validate wallet balance algebra, but an uploaded
document cannot grant itself reliable balances, complete activity, or an Actual
account mapping. The application deliberately discards those imported authority
fields. The existing wallet-materialization action creates a zero-balance Actual
account through the governed mutation pipeline.

## Decision 1: admission of local statement proof

Recommended: permit **human-attested statement evidence**. A freshly authenticated,
authorized human reviews the original document and its exact extracted wallet,
currency, opening/ending balances, statement interval, and activity coverage.
This is a human attestation, not independent authentication of the statement's
issuer. It enables an offline workflow without provider credentials or external
evidence transmission.

Alternative: require independently authenticated provider evidence. This gives
stronger source assurance, but no approved integration currently supplies that
proof. Wallet balance conclusions would remain unavailable; camera evidence,
manual categorization, and unrelated Actual work would continue.

The server-owned immutable attestation must
bind document identity/hash and parser version; a scoped wallet identity;
currency and exact balances; precise period boundaries and included activity
identities; actor, policy, approval time, and decision hash. The native contract
must validate period coverage, overlaps, duplicates, boundary events and balance
conflicts. One statement cannot declare the entire visible history complete.
Owner/source grants, stale/replaced documents, revocation, policy changes, and
restore quarantine must invalidate dependent proofs and proposals. Proof
references must reach wallet blockers and the unified attention surface.

## Decision 2: materializing a nonzero opening balance

Recommended: extend the existing typed wallet-materialization action with an
exact dated opening-balance proof, visible budget effects, and explicit Actual
opening-transaction/account-balance postconditions. Ordinary proposal approval,
execution fencing, reread verification, recovery and audit remain mandatory.
This changes financial semantics; the user separately approved this extension.

The existing zero-balance action remains suitable when complete evidence can
reconstruct activity from zero. It cannot represent an arbitrary nonzero
statement opening without inventing history. A generic income or refund credit
must not stand in for opening equity. Linking a user-created Actual account is
a useful additional path, but does not complete automatic materialization.

## Independent work

Neither decision blocks optional camera line/tender entry, immutable human item
decisions, approved exact-rule suggestions, repeated-outcome proposals,
contextual rule simulation, or read-only Spend Session receipt reconciliation.
Stable wallet/account identity after a verified zero-balance creation is a
separate correctness requirement: later legitimate balance or name changes must
not cause an inferred collapse or a duplicate account proposal.

No new packages, live integrations, credentials, deployments, or external model
calls are proposed by these decisions. Email forwarding remains deferred.

## Exact approval request to relay

1. **Statement proof:** “May I implement human-attested local wallet statements,
   where a fresh authorized human approves exact document bytes/hash, wallet,
   currency, period, balances and included activity, and the UI explicitly says
   this is human attestation rather than provider authentication? Rust will
   validate conservation and coverage; stale, conflicting, revoked or restored
   proof will invalidate dependent conclusions.”

   Options: approve human attestation (recommended for the local workflow), or
   require independently authenticated provider evidence and leave wallet proof
   unavailable until a separate integration is approved. Never trust uploaded
   reliability, completeness or balance-authority flags.

2. **Opening equity:** “May I extend the existing governed wallet-materialization
   action to support an exact dated nonzero opening-equity balance, with visible
   budget effects, ordinary independent approvals, Actual reread verification
   and explicit opening-transaction/account-balance postconditions?”

   Options: approve that typed extension (recommended), or retain zero-balance
   creation only and leave arbitrary statement openings unsupported. An income
   or refund credit will never substitute for opening equity.

Both requests cover application code and synthetic tests only. They add no
packages and authorize no live account access, financial writes, credentials,
external evidence transmission, deployment, push, or remote pull request.
Both recommendations were explicitly approved. This records design approval,
not completed implementation or release acceptance.

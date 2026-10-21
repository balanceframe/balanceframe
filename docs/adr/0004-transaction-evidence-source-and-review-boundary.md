# Transaction evidence source and review boundary

Status: implemented foundation; full Phase 11.5 acceptance is pending.

Actual owns ledger facts. Transaction evidence is immutable workflow data, and
an extracted observation is a source claim rather than a new transaction. Rust
receives versioned normalization, validates financial relationships, and produces
inspectable results. Raw documents and connector payloads remain in TypeScript.

## Source authority

Local imports cannot identify themselves as Actual transactions, install reviewed
ledger effects, confirm relationships, or establish a wallet's opening balance.
Their source identity is bound by the server, reliability is unverified, and
relationships become candidates. Financial uncertainty remains explicit.
An authenticated actor can review an exact current resolution, confirm or reject
a relationship, record purpose, and define an exact consequence with fresh human
proof. Source and policy changes invalidate that review. Decisions retain the
original financial observation kind; review authority is separate metadata.

Spend Session imports retain their exact saved version and pending state. They
do not assert that a planned purchase settled. Received payments have no default
income interpretation. Pending saved items are retained for inspection. Explicit receipt comparison
reconciles item mappings, substitutions and coverage without promoting planned
prices to settlement facts.

Current Actual rows are normalized again inside the existing consequential-action
capture. Stable per-record provenance identifies unchanged facts across capture
times. An overlapping, ambiguous settlement prevents a new evidence-derived
debit. The ordinary action service still owns authorization, current snapshot,
canonical plan/hash, approval, adapter write, Actual re-read, postcondition, and
audit. Evidence ingestion and resolution never write to Actual.

## Privacy and lifecycle

Space, budget, connection, private owner, and exact source grants bound evidence.
Normalized evidence, raw bytes, source references, proposed effects, and deletion
have separate authority. Collection publication also checks aggregate operation
limits. Ingestion does not grant visibility. Raw source bytes use AES-256-GCM
with authenticated immutable metadata and a separate random 32-byte key file.
The web key file defaults to `evidence.key` beside the workflow database; an
operator can set `BALANCEFRAME_EVIDENCE_KEY_PATH`. Invalid or broadly readable
keys fail closed and are never regenerated over existing encrypted content.

Default raw retention is seven days, configurable per import from one through
thirty days. Authorized reads enforce the deadline immediately. A server startup
and sixty-second housekeeping sweep also erases expired ciphertext without
requiring a source to be opened or its former viewer to retain access. Minimal
content-free lifecycle audit survives. Restored backups quarantine raw bytes and
prior source decisions so deleted content cannot silently become usable again.
Backups and user-downloaded exports have their own retention obligations.

## Review and deployment boundaries

Exceptions use the existing home attention surface and Review page. No permanent
wallet or receipt inbox is introduced. Optional source failure leaves unrelated
Actual workflows usable; an unavailable source cannot supply a valid projection.

Exact SKU/item rules are immutable, owner-scoped proposals with native historical
simulation, examples, conflicts, account/source scope, policy version, expiry,
and a canonical approval hash. Fresh human approval and revocation are separate
actions. Publication rechecks source permissions, Actual rule visibility and
approval state after asynchronous reads. Approved rules produce local suggestions;
Actual does not support the same item predicate, so no broad merchant rule is
silently substituted or exported.

The camera/photo form accepts JPEG/PNG and optional exact, unverified manual
receipt facts bound to the original image hash. Uploaded retail PDFs reuse that
manual path, preserving exact original bytes and unverified status; OCR remains
JPEG/PNG-only. Missing lines remain unknown;
receipt differences are not repaired during parsing. Local JSON extractions
remain supported; sources without extraction stay explicitly unsupported.
Email forwarding has been deferred by the user. The existing HMAC verifier is
only an unused integration primitive. Approved local OCR runs in a separate,
disabled-by-default Compose profile. The core has no OCR startup or health
dependency: explicit extraction returns untrusted text, and manual entry always
remains available. The component receives only the supplied image; it receives
no budget credentials or financial authority. Live mailbox access and reviewed
wallet-balance proof are not established by these primitives. Separately approved
human-attested statement coverage and opening equity are described in
[ADR 0005](0005-wallet-proof-authority-options.md).

The action contract now supports exact new debits, credits/refunds, and existing
settlement category/split amendments in the same governed pipeline. Amendments
bind the full original canonical transaction and a private SDK metadata proof,
preserve settlement metadata, and verify both raw and canonical postconditions.
Uncertain recovery requires fresh proof and never redispatches a write. Final
independent review and workspace acceptance are still required.

See the [implementation status](../roadmap/post-mvp/11-5-implementation-status.md)
for current acceptance evidence and remaining work.

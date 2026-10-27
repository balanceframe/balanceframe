# ADR 0009: Synchronization-capable categorization preview

Status: accepted for implementation, 2026-10-27. Browser and production acceptance
remain separate gates. This supersedes the mutation-free acquisition requirement
for the categorization preview; it does not approve arbitrary financial actions.

Use the existing supported Actual SDK lifecycle. No SDK fork, new package or
server change is required. Connecting, downloading and shutting down may upload
pending financial messages or archives, run migrations and post Actual's configured
scheduled transactions. Background SDK work may overlap or outlive the request.
Successful shutdown is not a remote-settlement or quiescence receipt.

Separate the logical source-preparation and computation phases. Before any SDK
lifecycle access, admit the current human's selected space/budget, complete source
read scope and exact private proposal view. Recheck after waiting for the existing
process-wide lifecycle lock, including before another owner's cleanup. Agents
cannot use execution authority as permission to inspect private preview facts.

Normal source synchronization produces a detached local capture. One additional
local capture detects material changes without another remote-refresh loop.
Exclude generated read clocks from that comparison. This is bounded change
detection, not atomicity or proof of remote persistence. Check the complete
collections and facts needed for setting this category; unavailable unrelated
account-type or schedule metadata remains unknown, not fabricated or upgraded to
complete. Missing required facts, conflicting identities or detected changes block
the assessment.

The pure computation receives detached facts and the existing Native planner,
with shared approved-transaction precondition checks. It receives no SDK,
executor, claim/admission or workflow-mutation handles. Do not call Execute as a
dry run or use source wrappers that expire/reconcile unrelated workflow state.
Preview does not consume approvals, claim an execution, spend allowance, resolve
uncertainty or submit the proposed category change. Do not disclose private
preflight hashes or approval identifiers.

Recheck current authorization and proposal context before publication. Results
are private and request-local; no durable raw-snapshot registry is introduced.
Show the observation interval, locally observed/non-atomic/server-unconfirmed
semantics, source-effect warning and separate execution requirement. A failed or
cancelled request does not imply source synchronization was rolled back.

Actual execution remains unchanged: fresh source and authorization checks,
independent human quorum and normal durable admission are required. An uncertain
prior dispatch remains held and charged. A preview cannot recall or settle it.

Qualification uses disposable canonical budgets and the production SDK artifact.
Count explicit application mutation calls separately from SDK lifecycle effects,
compare the target category and source facts, and verify workflow claims,
approvals and uncertain admissions remain unchanged. Include scoped/revoked reads,
queued admission, incomplete or changing facts, pending human quorum, source
failure and delayed UI responses. Component/HTTP/SDK evidence does not substitute
for the still-required authenticated source-browser journey.

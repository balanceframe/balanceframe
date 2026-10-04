# @balanceframe/inference

ML inference abstraction.

Provides an abstract interface for classification models, enabling pluggable backends.

`Orchestrator` requires a trusted `authorizeCandidate` callback to authorize and
project each candidate before any authoritative layer or local/external provider
runs. Missing, revoked, failed, or empty-category authorization returns a denied
manual-review suggestion. The callback must use current authenticated identity,
space membership/delegation, resource grants, and policy—not model output.

Only the authorized projection reaches downstream classification or suggestion
metadata. Both authoritative-layer and provider results must remain within its
explicit category allowlist. External text redaction does not replace this
resource-visibility boundary.

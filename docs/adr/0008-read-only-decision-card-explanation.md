# ADR 0008: read-only Decision Card explanation

Status: accepted for code and synthetic tests. The owner approved extending the
existing OpenAI-compatible transport with a separate read-only Decision Card
explanation operation, disabled by default with independent server-owned policy
and allowlist. No provider connection or financial-data transmission is authorized
by that approval. This implements a bounded first cut of
[Phase 6](../roadmap/post-mvp/06-built-in-conversational-interface.md), not the
complete conversational interface.

## Decision

`POST /api/purchase/explain` accepts only the existing strict purchase intent.
It reuses `affordability:evaluate`, explicit selected-space/budget admission,
current membership/credential checks, the native purchase evaluation and its
authorized public Decision Card projection. Clients cannot provide a Card,
endpoint, provider, policy, actor, source facts, tool request or approval.
The web Purchase Check exposes **Explain this decision** after evaluation;
`purchase explain --json` invokes the same endpoint through the CLI's ordinary
authenticated selected-space transport.

The explanation provider receives only opaque fact references and canonical
outcome/funding/liquidity/reason codes. Resource IDs, exact amounts, names,
transaction/receipt text, private backing data, source hashes and credentials
are excluded. The response can select up to eight existing unique fact IDs or
refuse. It cannot return prose, financial values, a different outcome, an action,
authority or a tool call. First-party rendering supplies fixed labels and the
original authorized exact Money values. Provider ordering is advisory; the
deterministic Card remains authoritative and usable independently.
The explanation panel always presents the native outcome, both readiness
statuses and every blocker independently of the provider's selected details.
Adopting a newly evaluated explanation Card invalidates older proposal/transfer
readiness and fences late responses from those older contexts; preparing a new
proposal requires a fresh Evaluate action.

This operation shares only the existing HTTPS chat-completions transport with
classification. It has a separate versioned prompt and strict response parser,
an exact provider/model/endpoint/prompt allowlist, locality policy, a maximum
30-second deadline, 256 output tokens and a 64-KiB streaming response byte bound.
Redirects, incomplete output and malformed responses fail closed for explanation.
The endpoint may not contain user information, query parameters or fragments.
Provider errors and raw responses are not returned or logged by this operation.

Authorization, selected space, membership, credential lifetime, conversation
configuration and the source/state binding are checked before dispatch and
after asynchronous work. The binding remains private. A changed context
requires refreshing the Card; a late answer is discarded. Client results also
clear on intent, session/user change and unmount. Explanation does not approve,
execute, mutate Actual, create a claim or complete a Spend Session. Ordinary
evaluation's existing workflow reconciliation behavior is retained.

Source binding uses an explanation-specific representation. It omits only
generated Actual read-capture identifiers/hashes/clocks, including ledger-source
observation timestamps that match the capture and have no expiry. Bank-sync
timestamps, human/institution evidence clocks, explicit expiries and nested
provenance remain bound. Recovery's broader historical clock normalization is
unchanged. Advancing real-wall-time/real-native tests retain an existing backing
allocation across equivalent recaptures and reject changed authority timestamps
without changing financial values.

## Operator configuration

Nothing is enabled or connected by default. Classification or research provider
credentials do not enable conversation. No provider/model is chosen automatically.
An independently approved operator deployment can supply these server-only
environment settings through its normal secret/configuration mechanism:

```text
BALANCEFRAME_CONVERSATION_POLICY = {
  "mode": "external_allowed",
  "revision": "operator-policy-1",
  "timeoutMs": 5000,
  "allowedProviders": [{
    "id": "operator-provider",
    "model": "operator-approved-model",
    "endpoint": "https://approved.invalid/v1/chat/completions",
    "promptVersion": "decision-card-explanation-v1"
  }]
}
BALANCEFRAME_CONVERSATION_PROVIDER = {
  "id": "operator-provider",
  "model": "operator-approved-model",
  "endpoint": "https://approved.invalid/v1/chat/completions",
  "locality": "external"
}
```

Each variable contains one serialized JSON object; the display above is a
configuration example, not a file format or a command to connect a provider.
`BALANCEFRAME_CONVERSATION_API_KEY` must be supplied separately as a server secret.
Never put these values in public Nuxt configuration or a browser/CLI request.
Use `local_only` only for an operator-admitted local HTTPS deployment with
`locality: local`; classification's locality is not inherited. Use `disabled`
to withhold dispatch. Invalid/missing settings preserve deterministic evaluation
and return an explicit manual explanation state. Deployment environment changes
take effect through the operator's normal process lifecycle; no policy-editing
or secret-management UI is introduced.

Admission is limited to ten eligible explanation requests per actor, space and
budget per UTC minute, with at most 1,000 current scope buckets per web process.
It does not reset when a new request/configuration object is created. Disabled
or disallowed requests do not consume egress admission. This is a bounded
per-process limiter, not a durable billing quota or a shared multi-replica cap;
operators need their normal provider/deployment quota controls before separately
authorizing production use. Existing financial/delegation counters are untouched.
Stopping or revoking permission cannot recall bytes already dispatched; late
results are withheld when current authority or source binding changes.

## Verification and remaining scope

Regression-first synthetic transport, application, current-governance HTTP route,
component and CLI tests exercise independent policy, prompt/authority injection,
refusal, malformed/oversized/truncated output, deadline abort, exact integer
rendering, restricted public projections, stale source/credential/policy,
actor/intent lifetime fencing and deterministic fallback. The source route test
uses the real selected-space/governance wrapper with a substituted HTTPS fetch;
it is not a live provider or browser observation.

No provider was connected, no real credentials or budget data were used, and no
financial mutation was added. Real-browser acceptance remains open because the
already-recorded host Chromium sandbox failure was not bypassed or retried.
Natural-language intent resolution, free-form chat, history/memory, conversational
tools/mutations, other financial subjects, Hermes/MCP adapters and a first-party
agent Skill remain outside this slice. Full Phase 6 acceptance is not claimed.

Final scoped verification on 2026-10-27 passed: inference 265 tests, application
1,516, web 2,391 and CLI 209, with no skipped tests. Full-suite line coverage is
95.76%, 89.83%, 85.95% and 89.56% respectively. Root/Nuxt typechecks, root lint,
affected package builds and the Nuxt production build passed. Web coverage ran
after its application-dist build prerequisite; the production-bundle dependency
smoke and its exact SQLite assertions remained enabled. No dependency versions
changed. The unchanged-source native addon was reused with SHA-256
`ae79b28a0568818d95cc0c9b8fbe89e961fb26baf7295e9cb75535284906ac16`;
these are not fresh Rust or whole-workspace/native coverage gates. Compatibility
with the separately approved dependency updates requires the coordinated stack's
own validation.

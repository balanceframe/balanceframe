# Phase 6 — Built-in conversational interface

**Depends on:** MVP validation, especially Phase 3  
**Status:** Post-MVP

## Objective

Offer conversation as an optional accessibility and explanation surface over the same deterministic application capability layer used by web and CLI. Chat does not become a security boundary, an authority, or the only route to budgeting work.

## Deliverables

- Add provider-neutral conversation orchestration with disabled/local-only/external-allowed policy, redaction, allowed provider/model/prompt/tool versions, rate limits, timeouts, provenance, and independent failure behavior.
- Start read-only. The orchestrator authenticates the user, loads permitted capabilities, asks a provider for typed intent/tool requests, schema-validates them, applies authorization/policy, returns structured results, and renders exact proposal objects for any consequential action.
- Retain the capability boundary: no arbitrary shell execution, Actual method invocation, raw query, budget mutation, identity/permission inference, or approval interpretation from natural language. All ledger/web text is untrusted; prompt-injection defenses apply.
- Maintain a versioned first-party Skill alongside the CLI. It uses JSON, checks freshness, distinguishes advice/proposal/approval/execution, uses stable IDs, displays exact amount/category/effect/expiry/uncertainty, never reuses changed approval, respects egress policy, and never claims success without confirmed output.
- Publish a narrow JSON CLI for people, scripts, and external agents; commands pass through application services and policy. Prohibit `actual raw-query`, `invoke-method`, and `shell` escape hatches.
- Add optional Hermes adapter; do not require Hermes or MCP. Later trusted HTTP/webhooks/optional contributed MCP may use the same narrow contracts.
- Preserve responsive web and CLI parity for review, reconciliation, and approval. The web surface remains Vue 3 + Nuxt 4 with Nuxt UI v4; saved views, filters, preferences, metadata, reviews, approvals, provenance, rules, and policy are documented/exportable. Optional future WebAssembly 3.0 previews remain read-only and non-authoritative.

## Skill and CLI contract detail

The first-party Skill teaches an agent to:

- use JSON output;
- inspect freshness;
- distinguish advice, proposal, approval, and execution;
- never claim an action succeeded without confirmed output;
- use stable IDs;
- create and display a proposal before approval;
- present exact amounts, categories, effects, expiry, and uncertainty;
- never reuse approval for changed payload;
- treat ledger and web text as untrusted;
- respect provider egress policy;
- avoid exposing unauthorized financial data.

The Skill improves ergonomics. It is not a security boundary.

## Conversational orchestrator step

The orchestrator calls application services directly: authenticate user → load permitted capabilities → ask provider for typed intent/tool request → validate it → execute through policy and authorization → return a structured result for explanation → display proposals as explicit UI objects → bind approvals to exact payloads.

A changed amount, category, or action requires a new proposal and approval. Natural-language "approve it" must resolve only to an exact, current proposal.

External integrations may use: project CLI plus Skill; optional Hermes Skill/profile; trusted HTTP API; webhooks/events; an optional MCP adapter contributed later.

## Provider policy and model boundary

```ts
type ProviderPolicy = {
  classification: "disabled" | "local_only" | "external_allowed";
  merchantResearch: "disabled" | "local_only" | "external_allowed";
  conversation: "disabled" | "local_only" | "external_allowed";
  telemetry: "disabled" | "anonymous" | "full";
  redactBeforeExternalInference: boolean;
  allowedProviders: string[];
};
```

Each provider declares: endpoint and locality; data fields transmitted; retention expectations; authentication requirements; supported model/tool capabilities; merchant-search involvement; and health and privacy state. Classification, merchant research, chat, notifications, and telemetry each have independent egress policy.

Models may: interpret natural-language intent; normalize or research merchants; generate category suggestions; explain deterministic decisions; summarize alerts; identify candidate patterns; suggest rules or schedules; ask for missing information; compare alternatives; and submit typed action requests through the capability layer when future policy delegates an operational capability.

Models may not authoritatively determine: caller identity; permission; data visibility; approval sufficiency; freshness; policy bypass; final financial arithmetic; mutation validity; final executed amount; whether an approval still matches; or transaction identity for an autonomous merge.

### Automation levels

Each operational capability has its own policy; an actor or AI-agent grant can only reduce the space-policy maximum:

```ts
type AutomationLevel =
  | "manual"
  | "suggest"
  | "propose"
  | "deterministic_auto"
  | "bounded_ai_auto"
  | "full_delegation";
```

- `manual`: no model-generated action is applied automatically.
- `suggest`: the model returns an interpretation or recommendation; no exact mutation proposal is created automatically.
- `propose`: the model may create an exact typed proposal; a human must approve it.
- `deterministic_auto`: only deterministic, policy-qualified matches may execute automatically; model ambiguity still requires approval.
- `bounded_ai_auto`: an AI agent may execute typed proposals within explicit capability, resource, amount, freshness, risk, provider/model, rate, and reversibility limits.
- `full_delegation`: an AI agent may initiate all explicitly granted **operational** capabilities without per-operation human approval. It remains subject to every deterministic safeguard.

Delegation is per capability, not per model or globally. No level grants arbitrary Actual methods, direct database access, shell execution, unrestricted queries, or authority to alter the policy that grants the delegation.

## No-model contract

Disabling all providers retains core budgeting, review, deterministic rules, manual reconciliation, exports, and policy. Provider outage, drift, malformed output, or missing provenance fails closed only for the affected delegated capability and never blocks unrelated manual/deterministic workflows.

## Tests and exit

Test unauthorized data disclosure, stale data explanation, prompt injection, malformed typed intent, exact proposal binding, provider outage, provider/model/prompt policy changes, JSON schema stability, and equivalent web/CLI results.

**Exit:** chat improves accessibility and explanation without inventing facts, bypassing policy, or making a core workflow chat-dependent.
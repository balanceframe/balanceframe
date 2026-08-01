# Phase 9.5 — Delegated operational autonomy

**Depends on:** Phase 7 governance, Phase 8.8 financial decision and evidence foundation, and the existing proposal/mutation path  
**Status:** Post-MVP

## Objective

Allow users to delegate selected **operational** capabilities to attributable AI agents without creating a global autonomy slider, agent-specific write path, or exception to deterministic safety.

## Autonomy model

Each operational capability has a policy maximum; an actor/agent grant can only reduce it:

- `manual` — no automatic model-generated action;
- `suggest` — interpretation/recommendation only;
- `propose` — exact typed proposal, human approval required;
- `deterministic_auto` — only deterministic policy-qualified matches execute; model ambiguity still needs approval;
- `bounded_ai_auto` — AI may execute within explicit capability, scope, amount/freshness/risk/provider/rate/reversibility limits;
- `full_delegation` — AI may initiate all explicitly granted operational capabilities without per-operation human approval, while every deterministic safeguard remains mandatory.

Delegation is per capability, not global or per model. It may independently cover categorization, merchant normalization, evidence interpretation, receipt/product-family inference, deterministic evidence resolution, rules, transaction edits, reconciliation, budget changes, reallocations, transfer proposals, notifications, reports, and later operational functions.

## Deliverables

### Agent identity and bounded delegation

- Add independently auditable AI-agent identities distinct from delegating humans; versioned delegation records; exact capabilities/resource scopes; account/category restrictions; amount/count/day/week/month limits; cooldowns; provider/model/prompt/tool/locality/redaction restrictions; expiry; revocation; policy version; and delegating space/user.
- Add global and per-agent emergency stop, dry run, historical simulation, bounded rollout, complete execution/policy/delegation/provenance export, and visible agent audit history.
- Begin with dry run/simulation, then one low-risk capability in bounded rollout. Do not enable broad `full_delegation` as an early default.

### Evidence and decision delegation boundary

Evidence-layer semantic work—payment-note interpretation, receipt-text interpretation, product-family classification, and explanation—is distinct from proposing or executing a ledger projection. Space policy sets separate maximums, scopes, locality/egress/redaction rules, model/provider/prompt limits, and review requirements for each.

An agent may only act on an exact current snapshot, Decision Card, evidence-resolution version, or transfer-proposal hash. New evidence, a changed cart/account/category/funding path, a balance or freshness change, or a changed payload invalidates that authority. Agents cannot confirm bank-transfer settlement, materialize/migrate a wallet account, create a broad deterministic evidence rule, alter account roles/buffers/routing preferences, grant evidence access, or change evidence-retention/egress policy without a separate human-controlled workflow.

### Invariants

Every delegated action uses the ordinary typed intent/proposal, deterministic authorization disposition, latest snapshot, Rust plan/canonical hash, idempotency key, Actual re-read, Rust postcondition verification, and immutable audit path. It must satisfy current freshness/coverage, duplicate/reconciliation/risk blockers, provider provenance, resource scope, rate/amount limits, and policy version.

No autonomy level grants arbitrary Actual API calls, database access, shell execution, unrestricted queries, raw ledger credentials, or self-modification of authority. Provider outage, model drift, malformed output, missing provenance, disallowed model/provider/prompt/tool configuration, or insufficient deterministic evidence fails closed for execution.

### Control-plane boundary

AI agents may describe or propose, but cannot apply, grant, expand, renew, alter, or silently inherit authority over identity, membership, capabilities/scopes, approval requirements, delegation, provider/egress policy, retention, backups, ledger connections, or audit controls. Those operations require a human-controlled, re-authenticated workflow and configured human approvers.

## Tests and exit

Test agent attribution, scope/limit/cooldown precedence against space policy, separate evidence-interpretation versus mutation delegation, snapshot/Decision-Card/evidence-resolution/proposal-hash binding, change invalidation, expiry/revocation/emergency stop, provider/model/prompt restrictions, no self-escalation, prohibited settlement confirmation/wallet migration/rule creation/control-plane changes, denied data-quality/provenance/evidence paths, replay/crash recovery, control-plane re-authentication, and preservation of every normal mutation safeguard.

**Exit:** revocation takes effect before the next execution; agents cannot escalate authority; and each delegated mutation is attributable, bounded, replay-safe, policy-valid, and postcondition-verified.

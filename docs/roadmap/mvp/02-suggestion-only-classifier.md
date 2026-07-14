# Phase 2 — Suggestion-only classifier

**Depends on:** Phase 1  
**Status:** Upcoming

## Objective

Add optional, provider-neutral classification for ambiguity that deterministic processing cannot resolve. Suggestions are immutable workflow data, never ledger mutations; Actual remains read-only.

## Processing order

Resolve a transaction with the cheapest authoritative layer and stop once it is sufficient:

1. Actual imported-ID reconciliation;
2. Actual rules;
3. exact approved merchant mapping;
4. deterministic BalanceFrame policy;
5. approved historical similarity;
6. local lightweight classifier;
7. larger LLM classifier;
8. optional merchant research;
9. human review.

Rust determines candidate eligibility and deterministic evidence. TypeScript calls a provider only for candidates Rust leaves unresolved.

## Deliverables

### Provider policy and privacy

- Implement independent policy for classification, merchant research, conversation, and telemetry: disabled, local-only, or external-allowed; explicit allowed providers; redaction before external inference; provider endpoint/locality, transmitted fields, retention expectations, authentication, model/tool support, research involvement, health, and privacy state.
- Support a fully local provider path and optional external/OpenAI-compatible providers. Egress and failure are per capability: provider outage never blocks ledger access or manual review.
- Treat transaction descriptions, notes, merchant names, imported payees, web results, notifications, and user messages as untrusted content. There is no arbitrary shell, raw Actual method, unrestricted query, or unrestricted mutation tool.

### Structured suggestion contract

Persist an immutable suggestion with stable IDs for space, connection, budget, transaction, and transaction version; raw/normalized merchant plus optional research summary; category ID and alternatives; rationale; provider/model/prompt/inference-policy versions; creation time; originating actor; payload/provenance hash; and relevant Rust history/evidence.

A model score is metadata, not a calibrated probability and never authorization. TypeScript validates provider schema; Rust validates the suggested category against the current snapshot, eligibility, transaction version, policy, and blockers. Rejected/malformed output fails safely and preserves the manual path.

### Durable processing

- Persist suggestions outside Actual; retain provenance, alternatives, and failures.
- Enforce one active suggestion per budget, transaction, and classifier/prompt version; make candidate jobs idempotent across retries, repeated responses, crashes, and duplicate delivery.
- Show original imported evidence beside normalized/model output. A category deleted/renamed or transaction changed after inference supersedes the suggestion rather than silently applying it.
- Keep model/prompt upgrades visible in provenance and fixture comparison; protect against prompt injection in transaction text.

## Tests

Known deterministic payees, ambiguous merchants, conflicting history, malformed output, timeout/outage, malicious transaction text, model/prompt change, deleted category, stale transaction version, duplicate jobs, external-provider policy denial, local-only policy, and full provider disablement.

## Exit

**Suggestions, provenance, deterministic fallback, and failures can be evaluated against fixtures without any ledger mutation.**
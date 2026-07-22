# Phase 11 — Merchant intelligence and enrichment

**Depends on:** MVP evidence, trustworthy Actual gateway, proposal governance, and Phase 8 budget intelligence  
**Status:** Post-MVP

## Objective

Improve categorization and merchant/entity resolution when bank-imported transactions are sparse, while keeping every decision explainable, conservative, privacy-aware, and useful without external search. Enrichment may provide evidence; it never becomes permission to mutate the ledger or override explicit user decisions.

## Product principles

- Prefer authoritative local Actual data and user-confirmed mappings over inferred or external information.
- Treat imported payee, verbose title, notes, Actual payee, account, amount, date, currency, cleared state, and transaction metadata as separate evidence fields; do not collapse them into one opaque merchant string.
- Sparse evidence lowers confidence and may produce `insufficient_data`; it must never produce fabricated certainty.
- Preserve stable Actual IDs for payees, categories, accounts, and transactions. Human-readable names are display evidence only.
- Every suggestion exposes evidence, confidence, contradictory evidence, freshness, provenance, and the reason codes that influenced it.
- External enrichment is optional, policy-controlled, cached, attributable, and never required for review, rules, or Actual interoperability.

## Deliverables

### Phase A — Local deterministic intelligence

Build a provider-independent merchant and recurrence engine using local budget data:

- Exact and normalized imported-payee matching.
- Actual payee resolution with aliases and user-confirmed merchant mappings.
- Evidence from bank descriptions, verbose titles, notes, account context, amount sign/currency, and existing Actual payee records.
- Historical category outcomes, accepted corrections, explicit user overrides, and existing Actual rules.
- Cadence and distribution features:
  - day of month;
  - day of week;
  - month and year seasonality;
  - interval distribution;
  - number of occurrences per week, month, and year;
  - amount range, variance, and direction.
- Calendar-aware recurrence windows using a configured jurisdiction and time zone:
  - weekends and business-day shifts;
  - public holidays;
  - observed charge dates displaced by bank closures;
  - evidence such as “usually the first business day; this date is consistent with a holiday shift.”
- Deterministic conflict handling when several payees, merchants, rules, or categories are plausible.

The engine must distinguish ledger facts, derived evidence, advice, proposals, and execution results. A model may explain deterministic evidence but cannot change the facts, freshness, confidence, or final category without the proposal workflow.

### Phase B — Explainable review and rule learning

- Show the evidence contributing to merchant resolution and category selection in Review Transactions.
- Allow a user to confirm or reject merchant aliases and recurring-pattern findings.
- Generate exact rule proposals from stable Actual payee/category IDs, not BalanceFrame-only metadata.
- Include simulation, conflicts, affected transaction IDs, expiry, and the exact native Actual rule payload in every proposal.
- Preserve manual corrections as higher-priority user evidence until explicitly changed.
- Export the evidence and accepted native rule payload so the result remains understandable and functional if BalanceFrame is removed.

### Phase C — Provider-neutral external enrichment

Define a `MerchantEnrichmentProvider` boundary with:

- `disabled | local_only | external_allowed` policy per space/budget;
- provider and version;
- query and normalized merchant input;
- timestamp, cache TTL, confidence, source URLs, and failure state;
- rate limits, cost budget, retries, and circuit breaker;
- explicit egress declaration and redaction policy.

External requests should send only the minimum necessary normalized merchant text and, when explicitly allowed, coarse locale. Never send amounts, account IDs, full transaction history, category data, credentials, or private notes for merchant research.

External enrichment is evidence only. It cannot approve proposals, authorize mutations, create Actual rules, or override local user-confirmed facts.

### Phase D — Optional ValueSerp provider

Add ValueSerp as an optional server-side provider:

- API keys remain server secrets and never reach the browser or Actual.
- Cache results by normalized query and provider parameters to control cost and repeat traffic.
- Display provider provenance, source links, retrieval time, and expiry.
- Provide per-space opt-in, spending limits, rate limits, and a disable/delete path.
- Fall back to local-only intelligence when the provider is unavailable, over budget, or disallowed.

ValueSerp documents a structured `/search` endpoint requiring `api_key` and `q`. Its current pricing page lists a 100-search trial, pay-as-you-go pricing, and paid monthly plans; it is not a free operational dependency.

### Phase E — Evaluate a no-key/self-hosted option

Do not make HTML scraping of a public search page the default production implementation.

The actual-ai project demonstrates a useful fallback concept: a self-hosted free-web-search feature that requests DuckDuckGo Lite and parses results. However, that is page scraping rather than a supported structured search API and is vulnerable to markup changes, throttling, reliability issues, and provider policy changes.

Evaluate alternatives in this order:

1. Local evidence, user-maintained aliases, and a bundled/local merchant dataset — the preferred zero-marginal-cost default.
2. An instance-owned meta-search deployment only after licensing, upstream terms, security, reliability, and operating cost are reviewed.
3. Optional ValueSerp for users who explicitly opt in and configure it.

All providers use the same cache, provenance, authorization, redaction, rate-limit, failure, and deletion contract. Disabling every provider must leave categorization and review fully functional.

## Data and policy contract

```ts
type MerchantResearchPolicy = {
  mode: "disabled" | "local_only" | "external_allowed";
  allowedProviders: string[];
  redactBeforeExternalResearch: boolean;
  maxSearchesPerDay: number;
  maxSpendMinorUnitsPerMonth: number;
  cacheTtlHours: number;
};
```

Persist enrichment records with the provider, query fingerprint, fields sent, source URLs, retrieved timestamp, expiry, policy version, confidence, and deletion state. Re-authorize access before displaying or delivering enrichment. Search results and snippets are untrusted input and must not authorize actions or override application policy.

## Tests and exit criteria

- Fixed-calendar tests cover ordinary cadence, month boundaries, leap years, weekends, public holidays, and business-day displacement.
- Sparse-input tests verify conservative degradation and mandatory `insufficient_data` outcomes.
- Entity-resolution tests cover aliases, punctuation, imported-payee variants, duplicate payees, conflicting evidence, and explicit user overrides.
- Recurrence tests cover weekly, monthly, annual, irregular, and multiple-occurrence patterns with amount variance.
- External-provider tests cover disabled policy, redaction, cache hits, expiry, rate limits, cost limits, malformed results, provider outage, deletion, and fallback to local-only evidence.
- Every displayed external claim includes provenance and expiry.
- Native Actual rule exports remain valid and executable without BalanceFrame.
- Disabling all enrichment providers does not block synchronization, review, proposal approval, rule execution, or recovery.

**Exit:** local deterministic evidence materially improves sparse-transaction categorization; calendar and recurrence reasoning is explainable and conservative; optional external enrichment is policy-controlled and failure-tolerant; and every accepted rule remains a complete native Actual rule outside BalanceFrame.

## Sources

- [VALUE SERP API overview](https://docs.trajectdata.com/valueserp/search-api/overview)
- [VALUE SERP pricing](https://trajectdata.com/serp/value-serp-api/pricing/)
- [actual-ai project and feature description](https://github.com/sakowicz/actual-ai)
- [actual-ai free web search implementation](https://raw.githubusercontent.com/sakowicz/actual-ai/master/src/utils/free-web-search-service.ts)
- [DuckDuckGo acceptable-use policy](https://duckduckgo.com/acceptable-use)

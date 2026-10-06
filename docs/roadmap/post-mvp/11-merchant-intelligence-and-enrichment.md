# Phase 11 — Merchant intelligence and enrichment

**Depends on:** MVP evidence, trustworthy Actual gateway, Phase 7 proposal governance, Phase 8 budget intelligence, and Phase 8.8 shared financial evidence contracts
**Status:** Implemented and locally verified — optional paid-provider deployment remains gated

## Objective

Improve categorization and merchant/entity resolution when bank-imported transactions are sparse, while keeping every decision explainable, conservative, privacy-aware, and useful without external search. Enrichment may provide evidence; it never becomes permission to mutate the ledger or override explicit user decisions.

## Product principles

- Prefer authoritative local Actual data and user-confirmed mappings over inferred or external information.
- Treat imported payee, verbose title, notes, Actual payee, account, amount, date, currency, cleared state, and transaction metadata as separate evidence fields; do not collapse them into one opaque merchant string.
- Sparse evidence lowers confidence and may produce `insufficient_data`; it must never produce fabricated certainty.
- Preserve stable Actual IDs for payees, categories, accounts, and transactions. Human-readable names are display evidence only.
- Every suggestion exposes evidence, confidence, contradictory evidence, freshness, provenance, and the reason codes that influenced it.
- External enrichment is optional, policy-controlled, cached, attributable, and never required for review, rules, or Actual interoperability.

### Shared evidence boundary

Merchant intelligence resolves merchant/entity meaning from sparse ledger imports. It complements, but does not replace, Phase 11.5 economic-event reconstruction: merchant enrichment does not establish settlement matching, reimbursement linkage, wallet funding, receipt balancing, tender allocation, or transaction identity.

Phase 11 extends Phase 8.8's shared evidence vocabulary with merchant/payee identity and provenance: stable ledger IDs where available; raw and normalized display text; alias/source field; confidence; contradictory evidence; provider/parser/version; content/query hash; retrieval/source time; expiry; policy; and deletion state. Phase 11.5 consumes these as semantic evidence after deterministic monetary relationships are resolved.

Connector health/capability and provenance remain service-neutral, distinguishing source observations, normalized evidence, semantic suggestions, deterministic rules, ledger proposals, and confirmed execution. The merchant-specific contracts are implemented Phase 11 extensions, not evidence that Phase 8.8 already supplied them.

## Current implementation and change boundary

The Phase 11 surfaces below are implemented in the existing flow, without a parallel inference engine or review queue. The exit evidence below records local implementation acceptance and separately identifies unverified paid-provider deployment prerequisites.

| Implemented surface | Phase 11 behavior |
| --- | --- |
| `crates/financial-core/src/merchant_intelligence.rs`, `categorization.rs`, `analysis.rs` | Read-only merchant/2 normalization, scoped identity/category evidence, checked amount statistics and deterministic interval/calendar recurrence reuse native rule matching. Legacy recurrence projections use the same cadence kernel with explicit missing-provenance uncertainty. |
| `packages/actual-adapter/src/merchant-normalizer.ts`, `connector.ts` | Selected canonical imported-payee/notes/ID/split/transfer fields, collection availability and source dependencies are captured under the selected Actual budget lock; entire raw Actual objects are not retained as merchant evidence. |
| `packages/application/src/merchant-service.ts`, `composition.ts` | Current source/grant/policy admission fences native analysis and publication. Review and Dashboard consume shared recurrence results, including human pattern decisions, rather than occurrence-count `monthly` labels. |
| `packages/inference/src/merchant-research.ts`, `providers/valueserp.ts`; `packages/application/src/merchant-research.ts` | A dedicated typed public-business research request/result is separate from classification. The optional fixed-origin adapter and coordinator apply explicit preview consent, least-permissive policy, durable cache/quota/claim and lifecycle fences; dispatch remains off by default. |
| `packages/inference/src/redactor.ts`, `merchant-research.ts` | Existing classification redaction is unchanged. Research accepts only explicitly reviewed standalone merchant text and optional coarse locale, not the original transaction or financial context. |
| `packages/application/src/review-persistence.ts`; `packages/workflow-store/src/merchant.ts`, `merchant-migration.ts` | Canonical transaction authorization remains independent of classifier evidence. Existing persistence and transactional migrations store scoped intent/provenance and server-owned derivation lifetime; cleanup preserves human decisions and financial audit. |
| `apps/web/server/utils/workflow-store.ts`, `review-projection.ts`; `apps/cli/src/transport.ts` | Typed authorized evidence/action projections carry history, alternatives, rule candidates and provenance through the existing Review/API/CLI paths; opaque persisted evidence and server-only derivation stamps are not forwarded directly. |
| `packages/application/src/rule-mutation.ts`; `crates/core-protocol/src/native_rules.rs` | Stable Actual payee-ID rule planning reuses governed proposal/simulation/approval/execution, with complete reviewed impact and independently executable native rule semantics. |

Rust owns deterministic matching, scoring, recurrence, and checked amount statistics over normalized immutable inputs. TypeScript owns Actual normalization, authorization, policy, persistence, provider I/O, and presentation. Provider results never become ledger facts. Rust-owned canonical merchant types are exposed through `crates/core-protocol/src/merchant_intelligence.rs` and the N-API boundary, with versioned `protocol/json-schema/merchant-intelligence-v1.json`, checked-in TypeScript/Zod mirrors and contract fixtures. Keep these boundaries in lockstep; the `protocol-generated` package does not automatically regenerate them, and Phase 8.8's shared vocabulary does not substitute for the merchant records.

## Deliverables

### Phase A — Local deterministic intelligence

Extend the existing deterministic categorization and Phase 8 recurrence paths with provider-independent merchant resolution and the following local-data features; do not build a second recurrence engine:

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

#### Deterministic evidence contract

- Preserve source-field availability explicitly: unsupported, absent, and empty are different. Identify which Actual SDK fields supply each input; never invent a verbose title or treat a normalized display name as original bank text.
- Version normalization and preserve raw text. Match by budget-scoped stable IDs first; punctuation/case/Unicode normalization must not merge distinct payees silently. Model aliases as scoped, attributed, versioned confirmations/rejections, with supersession and conflicts rather than destructive payee merging.
- Apply explicit user corrections and applicable native rules before inferred history or external evidence. Specify conflict precedence and return unresolved/`insufficient_data` for contradictory authoritative evidence. Suggestions, model outputs, and rejected proposals are not accepted-history training labels.
- Group recurrence by authorized budget/account/payee identity and currency/direction. Define treatment of deleted, pending/uncleared, split parent/child, transfer, opening-balance, refund, and duplicate records; do not count both a split parent and its children or infer recurrence from occurrence count alone.
- Define minimum observations, history coverage, supported intervals, tolerance windows, confidence semantics, and deterministic tie-breaking in fixtures before implementation. Amount ranges/variance use checked arithmetic; missing currency or unsupported coverage produces explicit uncertainty rather than cross-currency aggregation.
- Keep scheduled expectations separate from observed recurrence. Use real Gregorian date arithmetic, including leap days/month ends, and test invalid dates, same-day occurrences, DST boundaries, zero amounts, and signed-i64 extrema. Preserve canonical Money decimal-string minor units/currency through evidence and simulation; never derive statistics from Review's floating display amount or assume every currency has two decimal places.
- Preserve ledger civil dates without UTC conversion. Calendar evidence uses explicit jurisdiction/subdivision, time zone, and versioned holiday data; unknown calendars and unsupported years degrade to ordinary cadence with an uncertainty reason. Bank-specific closures are not established merely by a national holiday.

The engine must distinguish ledger facts, derived evidence, advice, proposals, and execution results. A model may explain deterministic evidence but cannot change the facts, freshness, confidence, or final category without the proposal workflow.

### Phase B — Explainable review and rule learning

- Show the evidence contributing to merchant resolution and category selection in Review Transactions.
- Allow a user to confirm or reject merchant aliases and recurring-pattern findings.
- Generate exact rule proposals from stable Actual payee/category IDs, not BalanceFrame-only metadata.
- Include simulation, conflicts, affected transaction IDs, expiry, and the exact native Actual rule payload in every proposal.
- Preserve manual corrections as higher-priority user evidence until explicitly changed.
- Export the evidence and accepted native rule payload so the result remains understandable and functional if BalanceFrame is removed.
- Carry evidence through the application producer → workflow store → authorized API projection → Review and CLI consumers. Add typed confirmation/rejection actions for aliases/patterns without exposing arbitrary classifier JSON; show supporting/contradictory evidence, confidence meaning, provenance, and expiry with accessible loading/empty/error states.

- Alias/pattern confirmation changes evidence only; category writes and rule creation remain separate governed actions. Re-read current source facts, rule/payee/category identities, policy, and evidence versions before approval/execution; changed, deleted, expired, or superseded inputs invalidate the proposal.
- Extend native rule planning, simulation, hashing, execution, and postcondition verification to use the same stable-ID condition semantics. Prove the exported payload against a disposable Actual instance, including duplicate payee names, rename/merge/delete, existing-rule ordering, and authorization-safe refusal of effects outside the actor's scope without exposing their records or counts. Do not silently export a broader name-based rule.
- Capture proposal-time simulation with source snapshot/hash, evidence/policy versions, exact payload, affected IDs, conflicts, examples, and expiry. The current review proposal route reports missing simulation; execution-time simulation alone does not fulfill this requirement. Revalidation that changes the reviewed impact or payload requires a new proposal/approval.

### Phase C — Provider-neutral external enrichment

Define a `MerchantEnrichmentProvider` boundary with:

- reuse the existing `merchantResearch` capability vocabulary (`disabled | local-only | external-allowed`); add server-side space/budget policy persistence and resolution as new work;
- provider and version;
- query and normalized merchant input;
- timestamp, cache TTL, confidence, source URLs, and failure state;
- shared rate limits, cost budget, bounded execution, and local-only fallback; retries or circuit breakers require provider-specific justification rather than a mandatory new subsystem;
- explicit egress declaration and redaction policy.

External requests should send only the minimum necessary normalized merchant text and, when explicitly allowed, coarse locale. Never send amounts, account IDs, full transaction history, category data, credentials, or private notes for merchant research.

Normalization alone is not sanitization: bank text can contain names, card/account fragments, email addresses, phone numbers, or identifiers. Build the research request from an explicit merchant-only allowlist, with bounded text and opt-in coarse locale; if safe merchant text cannot be established, do not send a request. Redaction is unconditional, never a user-switchable boolean.

External enrichment is evidence only. It cannot approve proposals, authorize mutations, create Actual rules, or override local user-confirmed facts.

Compose research in `packages/application` with separately authorized API/CLI entry points and the existing Review evidence consumer. `apps/web/server/api/review/sync.post.ts` remains a local-analysis path; adding a provider adapter does not activate research automatically. Load scoped `merchantResearch` policy independently of classification. If Phase E selects a no-key external provider, explicitly adapt the existing policy's external-auth requirement without mislabeling remote search as local.

### Phase D — Optional ValueSerp provider

Add ValueSerp as an optional server-side provider:

- API keys remain server secrets and never reach the browser or Actual.
- Apply the shared cache, provenance, expiry, per-space opt-in, spending/rate limits, disable/delete, and local-only fallback contract.

At implementation-time inspection, the [ValueSerp overview](https://docs.trajectdata.com/valueserp/search-api/overview) documents structured HTTPS `GET /search` with required `api_key` and `q`. The [pricing page](https://trajectdata.com/serp/value-serp-api/pricing/) lists 100 signup searches, pay-as-you-go at $2.50 per 1,000 requests with a $25 initial purchase, and subscription plans; its FAQ counts successful Search API calls. These public terms are not the deployed account's tariff or a zero-cost operational dependency. No account was registered and no paid search was dispatched. Missing account-confirmed versioned pricing remains a dispatch refusal; uncertain dispatched requests retain conservative reservations rather than assuming a free failure.

### Phase E — Evaluate a no-key/self-hosted option

Evaluate local evidence, user-maintained aliases, and a bundled/local merchant dataset first.
Evaluate instance-owned meta-search only after licensing, upstream terms, security, reliability, and operating cost review; use optional ValueSerp only with explicit opt-in.
Do not make public-page HTML scraping the production default: actual-ai's DuckDuckGo Lite implementation illustrates the approach, not a supported search API contract.

All providers use the same cache, provenance, authorization, redaction, rate-limit, failure, and deletion contract. Disabling every provider must leave categorization and review fully functional.

#### Alternative evaluation and adoption decision

| Option | Licensing and terms | Privacy and reliability | Operating cost and decision |
| --- | --- | --- | --- |
| Existing admitted ledger evidence and user-maintained scoped aliases | Already-owned ledger inputs and attributed human decisions; no third-party merchant database or search terms required. | No external egress. Native IDs, exact Money, current source rights and explicit conflicts remain authoritative; sparse or ambiguous inputs abstain. | Reuses the existing native analysis and SQLite store. **Default selected**; no extra service or dataset maintenance. Synthetic quality results do not establish real-world coverage. |
| Local OpenStreetMap place/merchant extract | [OSM data is ODbL](https://www.openstreetmap.org/copyright/en), requiring attribution and applicable share-alike obligations; it is not a permissively licensed bank-to-merchant mapping table. Any distribution/combination requires a specific licence review. | A locally indexed extract avoids query egress, but place/category coverage is community-maintained and does not establish Actual identity, recurring payment cadence, or verified bank categorizations. **[INFERENCE]** Mapping bank text to places would require scoped disambiguation and independently evaluated labels. | Download/storage/indexing, update and adjudication costs are additional; no hosting or quality benchmark was performed. **Not bundled**: no demonstrated mapping need or licensed evaluated corpus justifies it. |
| Instance-owned SearXNG | [AGPL-3.0 source licence](https://github.com/searxng/searxng/blob/master/LICENSE); that licence is not permission to ignore each upstream search engine's automation terms. Review the chosen engines before deployment. | [Private hosting removes reliance on an unknown instance operator](https://docs.searxng.org/own-instance.html), but queries still reach upstream engines. Official [limiter guidance](https://docs.searxng.org/admin/searx.limiter.html) documents CAPTCHA/IP blocking; self-hosting is not an availability guarantee. | Requires hosting, patching, engine maintenance and possibly Valkey/proxy operation. “No API key” does not mean zero cost or offline processing. **Not selected**: a second production provider is unnecessary; no live deployment, latency, reliability or monthly-cost benchmark is claimed. |

The public [Nominatim service](https://operations.osmfoundation.org/policies/nominatim/) is not an automatic fallback: its application-wide maximum is one request/second, systematic place harvesting and autocomplete are forbidden, confidential input is prohibited, and service access can change without notice. A future local dataset or instance-owned search adapter must pass the same authorization, explicit egress consent, provenance, cache/lifecycle, bounded-I/O and quality contracts before adoption. No public-page scraping, public metasearch dependency, second provider or unpriced request was added.

## Data and policy contract

Extend the existing capability policy with scoped research limits; the sketch below describes stored values, not a second policy engine. Absent opt-in permits baseline local analysis only; missing/invalid research configuration denies external dispatch. Effective policy is the intersection of installation, space, budget, and current delegated authority: a less restrictive child cannot override a denial, provider allowlists intersect, and applicable caps all hold. `disabled` stops merchant research and its suggestion use, not native Actual rules, synchronization, or ordinary review; `local-only` excludes external-derived suggestions, including cache hits.

```ts
type MerchantResearchPolicy = {
  mode: CapabilityState; // existing @balanceframe/inference policy vocabulary
  allowedProviderIds: string[]; // reuse existing ProviderAllowlist naming
  maxSearchesPerDay: number;
  maxSpendMinorUnitsPerMonth: number;
  billingCurrency: string; // provider billing currency, not budget currency
  cacheTtlHours: number;
};
```

Persist enrichment records with the provider, scoped query fingerprint, names of fields sent (not their raw values), source URLs, retrieved timestamp, expiry, policy version, confidence, and deletion state. Re-authorize access before displaying or delivering enrichment. Search results and snippets are untrusted input and must not authorize actions or override application policy.

Persist scoped alias and recurrence decisions as well as enrichment: stable target/source IDs, match scope, accepted/rejected state, actor/time, optimistic version, and explicit supersession/revocation. Track a separate evidence revision bound to snapshot, normalization/calendar/alias/policy versions, and expiry. The existing review writer uses `transactionVersion: 1`, and workflow-store reuses an active issue for non-newer versions; Phase 11 must refresh/supersede explanations even when transaction/category IDs are unchanged, without reviving rejected findings or overwriting manual corrections.

### Authorization, privacy, and lifecycle

- Define server-enforced authority separately for viewing evidence, confirming/rejecting aliases or patterns, requesting research, changing policy/credentials, deleting records, and proposing rules. Use trusted actor/space/budget/connection identity and existing governance/resource checks; a UI toggle or `merchantResearch` policy is not authorization. Scope shared mappings explicitly; private evidence cannot train a shared conclusion merely because its transaction IDs are hidden.
- Do not reuse workflow-store's merchant-only correction selectors or global conflict aggregation as scoped learning queries. Require budget/source-resource predicates and current grants before derivation, and distinguish verified executions from approvals and legacy/unverified corrections. Explicit confirmation is evidence of user intent, not proof of an Actual write.
- Authorize and project source data before matching/history aggregation, cache lookup, search dispatch, persistence, rendering, exports, and notifications. Preserve the exact source visibility requirements on derived evidence; readers lacking them get no hidden amounts, merchants, confidence aggregates, query history, or result-count side channels.
- Cache only within authorized space/budget/connection scope, keyed by sanitized query, locale, provider/version/parameters, normalization version, and egress-policy version. Query hashes are not anonymization. Recheck current membership, source scope, policy, and expiry on hits; no cross-budget cache sharing or reuse after relevant revocation.
- Disable/revoke/delete invalidates cached eligibility and outstanding work. Capture a durable deletion/policy generation at admission and check it atomically with result writes; cancel queued work, abort in-flight work best-effort, and discard late responses even if cancellation fails. Recheck current grants/source versions before dispatch and commit. Include derived records and Phase 11.5 references in invalidation; a late response must not resurrect deleted records. Already-dispatched requests cannot be recalled: disclose that boundary and provider retention terms at opt-in.
- Define retention and purge behavior for queries, snippets, aliases, raw/derived records, logs, exports, and backups. Retain only the minimum non-content audit/tombstone needed for deletion and execution accountability; do not retain sensitive snippets inside immutable audit payloads. Application deletion does not claim deletion at an external provider.
- Keep credentials in server secret configuration with authorized rotation/revocation. Redact the entire ValueSerp request URL, including both `api_key` and merchant query `q`, from application/proxy/access logs and traces. Exclude credentials from cache keys, provenance, fields-sent records, and exports; keep sanitized query text transient and persist only its scoped fingerprint. Convert provider errors to bounded safe codes before generic error handling: the current web `sanitizeError` logs raw messages/stacks. Never pass it outbound request URLs or raw provider errors/responses.
- Prefer the fixed ValueSerp origin; administrator-configured endpoints must enforce destination/port, scheme, DNS/connect-time address, and redirect restrictions. Never accept an endpoint from transaction text or a request body; a reviewed self-hosted endpoint is an explicit trusted exception, not a general private-network fetch capability. Reject credential-bearing/cross-origin redirects. Do not fetch search-result pages automatically. Validate response structure/size; render snippets as text and allow only safe HTTP(S) source links, never provider HTML or executable links.

### Bounded execution and cost

- Local review/sync never waits for a provider. External research is an explicit authorized request over unresolved merchants, with bounded concurrency, deadline/cancellation, request/response/result limits, and per-provider rate limits. Deduplicate identical in-flight work within the same authorized scope; retry only with a bounded provider-specific policy.
- Reserve search quota and maximum billable cost atomically in persistent storage before dispatch, including concurrent processes and retries, with durable attempt identity. Track provider credential-wide limits as well as per-space limits when credentials are shared. Cache hits consume no provider searches; content deletion must not reset outstanding billing counters. Do not hold a database transaction open across network I/O.
- Validate nonnegative finite safe-integer policy limits and bounded TTLs; zero request/spend limits mean no paid dispatch. Define UTC daily/monthly windows and a versioned provider tariff in its billing currency. Accumulate sub-minor-unit charges exactly before comparing caps; do not round each fractional-cent request to zero. Unknown pricing or uncertain billing after timeout/crash keeps its reservation until reconciled rather than permitting unbounded spend.
- Capture authorized input under `ConnectionManager.withConnection`, then release Actual's process-wide lock before provider I/O. Perform research outside both that lock and database transactions; revalidate source/policy versions before publishing. Reuse existing scoped job/claim machinery if durable background execution is needed rather than adding another scheduler.
- Bound history by explicit coverage/horizon and return that coverage with results. Index/group transactions once by scoped identity; avoid rescanning the whole budget for each candidate and unbounded all-pairs fuzzy matching. Paginate evidence/review projections and persist only needed derived data; no network call per transaction on a cacheable merchant query.

## Implementation orchestration and rollout

1. **Contract and fixture gate:** map Actual fields and stable-ID native rule semantics; define canonical schemas, precedence, scope/lifecycle, and calibration examples. Adopt the planning defaults below, select the calendar source/license/coverage and applicable provider tariff, and baseline the performance targets before implementation. Record any evidence-based target adjustment before tuning; do not infer missing SDK fields or provider guarantees.
2. **Local vertical slice (A/B):** extend normalized input and Rust analysis, then governed persistence/proposals, Review and existing attention/CLI projections. Migrate the occurrence-count recurrence projection to the shared result. Prove local-only categorization, alias confirmation/rejection, and native rule round-trips before adding network I/O.
3. **External slice (C/D), then E evaluation:** implement one shared policy/cache/cost/lifecycle path and the ValueSerp adapter. Evaluate datasets/self-hosted search without requiring a second production provider. Provider failure must not regress the local slice.
4. **Persistence/release:** use existing workflow-store migrations for scoped aliases, policy, enrichment, and quota records, with schema validation and indexed scope/expiry lookups. Never backfill unconfirmed historical suggestions as confirmations. Invalidate derived data on relevant source/normalizer/policy changes. Test old-database upgrade and backup/restore; do not run older incompatible binaries against an upgraded database. External dispatch remains off until an authorized opt-in.

Primary ownership covers shared schemas, integration, and final acceptance. After the contract gate, bounded Rust/local-analysis and TypeScript provider work may proceed independently against those schemas; shared persistence and rule-boundary edits need one owner. Independent architecture/DeepReview and security review are required before implementation completion. Keep existing UI components/attention surfaces; review the new evidence/policy interactions for accessibility and responsive behavior rather than building a new dashboard.

## Recommended planning defaults and release targets

These recommendations guide implementation; numerical quality/performance targets are not measured results or established product capabilities. Calendar support and external enrichment remain optional. The contract/fixture gate must resolve the remaining selections below before implementing the affected slice; do not weaken release criteria after seeing evaluation results.

### 1. Holiday calendars and jurisdiction

- Use an offline, versioned holiday calendar selected explicitly per account, with a budget-level default. Never infer jurisdiction from currency, merchant text, IP address, or browser locale.
- Support national and relevant subdivision holidays and retain the calendar version in derived evidence. Missing jurisdiction or unsupported coverage falls back to ordinary cadence with an uncertainty reason, not a categorization failure.
- Treat a public holiday as a possible explanation for displacement, not proof that a specific bank was closed.
- Prefer a maintained, permissively licensed dataset/library over hand-written holiday rules. Verify license, observed-holiday rules, historical coverage, and update process before choosing it.
- Initial jurisdictions selected by the user: **US, Canada, UK**, including supported subdivisions, with explicit selection and no worldwide coverage claim. Use offline public/observed dates from **python-holidays 0.105 (MIT)** for **2020–2035**, with source/license attribution and reproducible pinned generation; no runtime Python or calendar network dependency. Outside coverage, retain ordinary cadence with uncertainty.

### 2. Evidence tiers, observations, and categorization quality

Use explicit evidence tiers rather than an unexplained confidence number: **confirmed** for an authorized user decision; **deterministic match** for stable identity or an applicable native rule; **inferred** for history/recurrence; and **insufficient/conflicting** when there is no defensible winner. Provider scores cannot promote inference into confirmation. Confirmation records user intent, not verified ledger execution.

- Require at least three eligible observations spanning two intervals for a recurring candidate. Two observations may be shown as a possible pattern, not established recurrence.
- Treat two annual observations as provisional and three as stronger evidence; keep an Actual schedule separate as a declared expectation. Counts alone never establish a pattern.
- Category inference requires minimum support, consistency, and conflict checks; choose its concrete support/tolerance thresholds using development fixtures before held-out evaluation. Never automatically merge payees on normalized text alone.
- Use at least **1,000 labeled transactions across 100 merchant identities**, including held-out merchant/time cases and separate synthetic boundary fixtures.
- Require **at least 95% precision** among inferred category suggestions and no precision regression against the existing baseline on the same evaluation set.
- Require **at least 10 percentage points more correct suggestion coverage** on the predefined sparse-input subset: correctly suggested transactions divided by all eligible transactions in that subset.
- Require zero explicit-override violations and zero unauthorized evidence disclosures. Report abstention, false alias matches, recurrence false positives, and denominators separately; do not hide unsupported subgroups behind an aggregate score.
- Report insufficient or unrepresentative evaluation data as a limitation, not grounds to lower the gate after evaluation.

**User-approved baseline clarification:** retain the 95% inferred-precision and 10-percentage-point sparse-coverage thresholds, but compare precision across all structured category suggestions on the same frozen labels. The legacy engine has no inferred-category output; report its inferred precision as unavailable, its measured structured-output denominator as one, and its financial-readiness diagnostics as limitations rather than inventing an inferred score or claiming clean legacy financial analysis. Unexpected or incomplete native/protocol responses still fail evaluation.

### 3. History size and performance

Benchmark current behavior first, serially on a documented CPU-capped reference environment. These are proposed local-analysis targets; evidence-based adjustments must be recorded before implementation, not used to excuse a failed release check.

| History size | Local-analysis latency target |
| --- | --- |
| 50,000 transactions | p95 ≤ 2 seconds |
| 250,000 transactions | p95 ≤ 5 seconds |

At the maximum supported dataset, target **≤ 512 MiB incremental analysis memory**. Also measure the end-to-end local Review path separately; external provider latency never belongs in Sync or ordinary Review.

- Default to a **five-year analysis horizon** to support annual patterns; disclose excluded history and effective coverage.
- Group/index once, paginate explanations/supporting transactions, and avoid full-history scans per merchant or unrestricted fuzzy all-pairs matching.
- Above the supported envelope, return explicit limited coverage rather than silently truncating or exhausting memory.
- Pin benchmark hardware/runtime, candidate counts, and measurement method at the contract gate; these targets are not hardware-independent guarantees.

Final native measurements use `scripts/merchant-intelligence/current.mjs`, release addon SHA256 `3fea89730df48ec777ac3322cabcb83ae5f7f9aec621ac444b1144751cff15b4`, Linux x64 on an Intel Core Ultra 7 268V, inherited CPU affinity 0–1, Node 24.18.0, two warmups and 20 serial samples per size. Node differs from the frozen baseline's 24.11.1; the affinity is not dedicated-core isolation. Admitted-history input serialization plus native-call p95 is 266.0 ms / 1,618.0 ms at 50k / 250k; the maximum incremental exported kernel-counter estimates are 35,520,512 / 280,743,936 bytes. All 40 samples completed uncensored.

The lossless `wide-or-private-and` workload separately measures native-window p95 1,191.8 ms / 3,853.7 ms and maximum incremental exported-counter estimates 100,941,824 / 217,837,568 bytes. Its 250k output retains 100,000 blocks, 100,003 parts, 50,000 sets and all 250,000 native classifications; none are capped or replaced by previews. Serialization uses a bounded 64 KiB staging buffer and returns the unchanged primitive-string ABI. These counters are not exact physical RSS or allocation measurements. The frozen native timing/memory window excludes deferred JavaScript response parsing: correlated input/native/parse p95 is 1,255.3 ms / 5,299.8 ms, so these native-window passes do **not** establish a five-second fully consumed response or the separate ten-second end-to-end Review target. Parse p95 alone is 66.1 ms / 1,452.4 ms.

All four final native reference workloads pass their frozen native-window latency and exported-counter gates with 20 uncensored measured samples per size after two warmups. The conflicting broad workload preserves weighted provenance and abstention; the producer-shaped workload retains disjoint predicates rather than inventing matches.

| Native workload | 50k serialization + native p95 | 250k serialization + native p95 | 250k maximum incremental exported-counter estimate |
| --- | ---: | ---: | ---: |
| Admitted history | 266.0 ms | 1,618.0 ms | 280,743,936 bytes |
| Wide OR / private AND | 1,191.8 ms | 3,853.7 ms | 217,837,568 bytes |
| Broad account oneOf AND | 949.3 ms | 2,639.5 ms | 219,598,848 bytes |
| Producer disjoint OR / AND | 1,575.2 ms | 3,186.8 ms | 226,205,696 bytes |

Source preparation, warm allocator residency, deferred response parsing, authorization, persistence, and end-to-end Review remain outside these native windows; total process memory and application latency are not bounded by these numbers. Correlated fully consumed 250k p95 is 1,619.9 ms for admitted history, 3,166.3 ms for broad AND and 4,026.2 ms for disjoint predicates.

These final quality/performance measurements belong only to measured addon SHA256 `3fea89730df48ec777ac3322cabcb83ae5f7f9aec621ac444b1144751cff15b4`; older intermediate artifact measurements are not substituted for this release binary.

### 4. Provider tariff and spending defaults

External research is off by default. Start with one production provider, explicit opt-in, and durable limits; a second production provider is not required by Phase E's evaluation.

- On opt-in, default to **20 searches/day per budget**, a **US$1/month application-dispatched usage cap where billing is USD**, and a **30-day result TTL** with visible expiry. Non-USD billing requires an explicit cap in its billing currency, not an implicit conversion.
- Start with **no automatic retries**. Keep ambiguous timeout reservations until reconciled; identical authorized cache hits incur no new search.
- Use exact integer sub-cent accounting and reserve the maximum applicable charge before dispatch. For arithmetic illustration, a tariff of $2.50 per 1,000 searches is $0.0025 per search and must not round to zero cents; verify the actual account/plan tariff before configuring it.
- Treat trial credits as a bonus, never a required dependency. Missing or unknown pricing prevents potentially billable dispatch.
- Disclose that the application caps only its own requests—not provider subscriptions, manual usage, or another application's calls using the same key. Recommend a dedicated key and provider-side limits where available.

### 5. Retention and deletion defaults

Keep durable user decisions; make external research disposable.

| Data | Default retention |
| --- | --- |
| Raw provider responses / downloaded pages | Do not persist; automatic page fetching remains out of scope |
| Sanitized query text | Transient only; never log |
| Scoped query fingerprint and selected attributed results | 30 days |
| Confirmed/rejected aliases and patterns | Until explicitly superseded, revoked, or scope deleted |
| Minimal operational attempt metadata | 30 days |
| Content-free billing reconciliation records | 90 days; longer only for unresolved charges |
| Proposal/execution audit | Existing governance retention policy |

Disable/revoke makes affected evidence unusable immediately; deletion fences in-flight writes and purges derived copies. Any retained supersession/deletion audit is minimal and content-free. A billing counter must not contain merchant text or disappear while needed to enforce outstanding spending limits.

Durable Review/projection copies carry server-owned derivation scope, private owner (or explicit shared visibility), and the original capture/expiry; reviewer assignment is not ownership. Cleanup retires each nearest-attributed bundle at its original expiry or inclusive 30-day capture boundary, including associated fingerprints, without renewing it on unchanged publication. Actor deletion preserves other actors' and shared bundles. Unattributed legacy derived copies fail closed within the selected namespace; independently known legacy namespace boundaries remain enforced through nested cleanup. Pending inferred targets are superseded only when their authoritative bundle is removed; durable human decisions and exact proposal/execution audit remain protected.

At 30 days, private and shared research attempts both lose merchant-derived query/intent/source/visibility fingerprints. Opaque idempotency tombstones, exact billing counters/windows and live worker claims remain available internally; retired content cannot be reused as an admitted attempt. Scope deletion and restore apply the same content-free boundary while preserving unresolved charges.

Recommend a **30-day backup retention window** where deployment policy permits it; document any different window and preserve deletion fences across restore. Do not claim deletion from external providers or user-downloaded exports.

The user changed the quality-corpus selection to independently labeled synthetic records; no user-supplied corpus is awaited. `protocol/fixtures/merchant-quality.synthetic.json` contains 1,200 held-out transactions across 100 invented merchants, 480 separate training records, and separate recurrence/boundary scenarios. Seed `110042` and SHA256 `691b579eab8c6dd1457b8b9f9dbd066db507b4732d9be05ece4ca5070ff78a3d` were frozen before either engine was evaluated. Synthetic challenge results do not establish real-world accuracy or natural case prevalence. The initial run measured inferred precision 474/552 (85.87%), below the unchanged 95% gate; the shared conflicting-field resolution fix now measures 474/474 (100%), zero false aliases among 597 resolved identities, and 312/1,000 correct sparse coverage (+31.2 percentage points), without changing labels or thresholds. Under the user-approved comparable-output criterion, the synthetic quality evaluation passes: all structured category precision is 477/477 for the current engine versus 1/1 for the frozen baseline, and current explicit overrides are correct in all three cases. Baseline inferred precision remains unavailable (0/0), its structured precision has only one observation, and its 30 financial-readiness errors remain explicit limitations; this is neither a clean legacy financial-analysis result nor Phase 11 exit verification. Applicable provider tariff and deployment-specific backup retention remain server-owned selections. Implementation uses disposable fixtures and no production credentials, paid calls, or self-hosted deployment.

The final bounded-string native artifact above re-ran the frozen synthetic corpus with all six quality gates passing and the same category/alias denominators. Abstention is 732/1,209 eligible held-out observations versus 1,208/1,209 for the legacy baseline; baseline explicit overrides fail 2/3 versus 0/3 current violations. Independently labeled recurrence partitions give 9/9 established patterns, zero false positives among 12 negative partitions, and 3/3 provisional patterns correctly remaining provisional. This engine-only corpus does not measure authorization/privacy or replace authenticated browser, native Actual execution, coverage, or integration acceptance.

## Integrated runtime evidence

Authenticated source-browser verification uses `http://127.0.0.1:3073/review` against a disposable Actual server at `http://127.0.0.1:5019`, the canonical protocol fixture, and eleven mapped synthetic merchant-quality rows. Better Auth is active and the development authentication bypass is disabled; no production budget is connected.

- Physical Sync succeeds and returns 45 queue items. Aster Atelier's pending `−749.65 USD` transaction displays inferred evidence, three scoped Checking observations, three matching Groceries outcomes, and the exact native payee/category IDs; this is historical consistency, not calibrated confidence.
- The monthly Aster Depot partition displays four `−12.00 USD` observations from January through April 2026, exact amount variance `0 / 1`, and conservative `calendar_unknown` reasoning. Input coverage is 120 transactions, 84 eligible and 36 excluded, with zero truncation; schedule coverage remains partial.
- A persisted native rule proposal opens through the real Proposed rules control after a page reload. Its list and exact detail both report simulation present. The complete reviewed impact contains seven affected IDs and seven rows: six unchanged Groceries matches and the one pending category change. Global future effect, exact payload hash, requester membership, expiry, and missing independent approval are visible. The rendered standalone JSON contains only Actual's native stage, condition, and action fields.
- Native reviewed simulations use the authorized projection rather than raw private preconditions. Their repeated detail occurrence participates in both operation-count and gross-outgoing disclosure limits. Regression tests cover current, expired, withheld, and independently restricted count/outgoing states.
- The delayed initial Better Auth session cannot permanently erase the proposal entrypoint: null-to-authenticated resolution reloads the existing read paths after synchronous private-state invalidation. Direct actor switches and signout remain clear-only, and old responses remain lifetime-fenced. Real-browser requester text also wraps within its authority column instead of overlapping the membership epoch.
- Canonical signed native Money still admits `i64::MIN`; normalized nonnegative Review action authority remains bounded by `MAX_I64`, consistent with governance. Its unrepresentable absolute minimum is explicitly refused, never clamped. A two-target regression verifies that this refusal publishes no partial inbox while representable unsafe-display amounts retain their exact signed Money without an invented numeric zero.
- A genuinely invited and signed-in second human initially receives proposal `404 / NOT_FOUND` and cannot inherit requester evidence or controls. After explicit disposable read and exact native-approval grants, that actor reviews all seven rows and records the same displayed hash through fresh reauthentication; no execution control is offered and a direct execution attempt remains `404`. Requester signout removes private merchant/proposal state and exact-action controls without page errors.
- The requester signs in again and explicitly executes the independently approved proposal: HTTP 200 returns a verified native rule. Receipt replay returns the same rule ID, and the Actual SDK observes exactly one rule. Proposal, approval, creation and replay preserve the complete 120-transaction ledger digest and the pending `−749.65 USD` transaction's null category. The newly created rule receives an explicit fixture read grant; creation does not implicitly broaden source-read permission. Post-execution physical Sync again succeeds with 45 usable queue items and every enrichment provider absent.
- Actual's API alone, with no BalanceFrame application, native addon or matcher imported, returns persisted rule semantics identical to the rendered standalone JSON. Its native importer categorizes an uncleared future `−749.65 USD` transaction in Savings using the exact payee-ID rule learned from Checking. The probe transaction is deleted before SDK shutdown; a subsequent complete SDK read confirms the original ledger digest, 120 transactions, and exactly one native rule.
- A real password-confirmed monthly pattern is accepted at private version 1 and rejected at version 2 without changing ledger transactions. The built CLI, using the genuine Better Auth and server-issued reauthentication cookies, confirms/rejects the current revision at versions 3/4. A later browser confirmation is durable at version 5.
- The actual Dashboard previously used the legacy recurrence fallback despite available scoped merchant authority. It now releases the initial Actual lock before independent shared analysis and retains its full publication guard through the final connection reload. The real Dashboard hides the rejected pattern, then shows `aster depot`, `−12.00 USD`, monthly, four observations, `2026-04-15`, **Confirmed** after explicit human confirmation. Source/native integration tests also cover exact JPY and final-await analysis-grant revocation.
- Real built-CLI analysis/evidence/policy reads use the same authenticated actor, selected budget and disposable Actual source. A one-explanation page still includes the independently matched pending native transaction and its complete rule graph. Reversible removal of the exact `merchant:analyze` grant yields CLI `FORBIDDEN` and API HTTP 403 with no merchant result; restoring it recovers the 120-record source.
- Independently authorized public-business preview, using manually entered `OpenStreetMap Foundation`, returns HTTP 200 with `denied / configuration` while installation/space/budget policies remain local-only and no provider is configured. Send remains disabled, no research-send request is made, and local queue/evidence remain usable. Earlier missing-authority and stale-revision previews are refused without leaking source data.
- Genuine human CLI policy control moves the budget from local-only to disabled (version/generation 1), then back to local-only (2). The actual disabled UI shows no merchant suggestions/patterns while preserving ordinary Actual-native matching and the 45-item queue. Restoration preserves the accepted four-observation pattern at durable decision version 5.
- A freshly reauthenticated, independently authorized browser export returns the selected scope, exact 120-record analysis, current policy and the accepted decision without provider credentials. Genuine human CLI deletion advances the budget generation from 2 to 3 and purges derived decisions: a subsequent authorized export has no decisions, while local-only policy, all 120 source transactions, the unreviewed four-observation recurrence and the one Actual-native rule remain. Physical Sync remains usable after deletion.
- Separately observed complete Review Sync takes **821 ms** on this disposable 120-transaction fixture: the timer waits for the successful Sync response, the governed queue refresh, 45 settled items and the enabled Sync control. An earlier 231 ms observation covered only the response/early toast and is not complete-path evidence. One observation is neither p95 nor a 50k/250k end-to-end benchmark.
- At 390px, merchant evidence grids and alias selects remain within their content bounds and retain both full 64-character revisions. The separate unchanged application header still produces 12px horizontal document overflow; this verification does not claim a globally overflow-free mobile shell.
- A freshly compiled disposable SQLite workflow-store retention smoke uses the canonical representative fixture: deleting the actual private owner retires an unassigned Review bundle while preserving peer/private and shared copies before their original expiry. A foreign known legacy namespace and ordinary nested canonical `sourceRevision` survive selected cleanup; exact Money remains unchanged. Cleanup at the inclusive original expiry retires the remaining selected derived copies. This is compiled store-lifecycle evidence, not browser/provider acceptance, and performs no Actual ledger mutation.
- A deterministic released-port-reuse regression reproduces the observed Actual reset failure in 597 ms: selecting the same web/Actual port lets Nuxt answer the initial Actual readiness probe before Actual initializes. Reserving both loopback ports together removes that failure without retries. The complete process-runtime and original purchase/payment scenario targets pass all 29 tests, followed by strict TypeScript, zero-warning ESLint and the full serial production build. Independent correctness and security review found no patch defects. The historical coverage run did not record its port pair; the regression proves this failure class and repair, not retrospective identification of that pair.
- Fresh authenticated alias verification follows physical Sync and the 45-item settled queue, then loads the complete 120-record source. For Target transaction `046083db-3bbf-4959-8797-ec628f9e6459`, absent `importedPayee` cannot enable Confirm. Selecting admitted native `payeeName` and the exact payee `fd674d8b-36f5-4036-9295-39cd46be27ac` enables it without inventing bank text. Fresh password confirmation creates private/account-scoped alias `9035746a-42d1-4364-809b-ee306c523cf0` at accepted version 1; rejection advances it to version 2 and reloads the visible attributed contradiction. Reauthentication, rejection and evidence reload return HTTP 200; the browser has no page or console errors. A visual capture shows the durable rejected state. A subsequent complete Actual SDK read preserves all 120 transactions, the original ledger digest, pending null category and exactly one native rule.

Final Rust/Nix formatting, all-target Clippy with warnings denied, all 29 disposable-Actual CLI scenarios, five native/service fault variants and all four x86_64-linux Nix flake checks pass. Current full isolated execution/coverage, production build, TypeScript, zero-warning ESLint, authenticated alias controls and final-binary quality/performance also pass. Nix does not exercise the incompatible aarch64-linux outputs on this host. Live paid ValueSerp dispatch, actual account tariff, upstream retention and deployment proxy/log redaction are not verified: no key or priced opt-in is configured. Deterministic adapter/coordinator/API tests exercise outage, cancellation, revocation, late-result deletion fences and restore holds; those are not live-provider browser claims. The only retained Actual mutation is the explicitly verified native rule; standalone interoperability and human alias/pattern/policy controls preserve the original ledger.

## Exit evidence matrix

| Contract | Implementation and consumers | Observed evidence |
| --- | --- | --- |
| Source fidelity and shared semantic boundary | Actual `merchant-normalizer.ts`; Rust/core protocol; versioned JSON Schema and TypeScript/Zod mirrors; N-API | Canonical source/result round-trips, strict availability/identity/version cases, native boundary tests and the complete 120-record authenticated fixture. Semantic suggestions cannot assert execution or economic-event relationships. |
| Deterministic merchant/category inference and exact statistics | `financial-core/src/merchant_intelligence.rs`; shared categorization kernel | Conflict/override/sparse/duplicate/split/extrema regressions pass; frozen synthetic corpus measurements remain artifact-specific below. |
| Conservative recurrence and offline calendars | Shared Rust cadence kernel; application calendar data/lookup; Review and Dashboard | Fixed-calendar and recurrence partitions pass; real four-observation monthly pattern is confirmed/rejected through browser and CLI. Missing calendar selection remains `calendar_unknown`, not an invented holiday. |
| Attributed aliases/patterns and current explanations | Merchant service, workflow store, Review panel, merchant API and CLI | Scoped/versioned/stale/conflicting decision tests pass. Real alias acceptance/rejection at versions 1/2, pattern controls, policy changes, export/delete and CLI authorization parity pass; unavailable bank text cannot confirm an alias. |
| Stable-ID native rules and complete impact | Native planning/simulation; governed proposal/approval/execution; Actual SDK | Seven exact reviewed rows; scoped second-human approval; one verified/idempotent native rule; Actual-only future Savings import categorizes correctly without BalanceFrame and restores the original ledger. |
| Policy, minimum egress and optional provider failure | Dedicated inference request/ValueSerp adapter; application coordinator; merchant research API/UI/CLI | Full suites cover least-permissive policy, explicit consent, unsafe text/links, bounded I/O, no retries and safe failures. Real local-only preview dispatches nothing; disabled enrichment preserves native Review and Sync. |
| Cache, exact cost and worker lifecycle | Scoped durable cache, fractional-cost reservations, credential/budget limits and claims | Full suites cover duplicate workers, cache reauthorization, fractional charges, UTC boundaries, uncertain outcomes and live lease occupancy through deletion/restore. No live account tariff or paid dispatch is claimed. |
| Retention, ownership and deletion | Server-owned derivation stamps; existing Review/projection tables; merchant store maintenance | Failing-before/passing-after regressions and compiled SQLite smoke verify original expiry/30-day age, private owner versus assignment, nested other-owner/shared/legacy scope preservation, retired fingerprints and protected Money/human/audit records. |
| Authorization and publication | Complete source/numeric manifests; final-await subject, membership, delegation, policy and SDK-dispatch fences | Full regression suite passes; real second-actor denial/approval, signout clearing and reversible analyze-grant revocation produce the documented 404/403 outcomes without inheriting private evidence. |
| Quality and performance | Frozen labeled fixture; quality evaluator; four lossless native workloads | Final release artifact passes all six quality gates and all eight size/workload native-window latency/memory gates. Complete 250k wide-OR output parses at correlated p95 5,299.8 ms; physical process memory and end-to-end Review are not represented by native-window limits. |
| Independent review and deliverable inventory | DeepReview/security passes over integrated phase, Attention, final retention and runtime port isolation; read-only exit inventory | Current reviewed patches have no remaining reported findings; the inventory identifies no additional concrete implementation gap. Reviews are static evidence, not test or live-provider execution. |
| Build, execution and coverage | Serial workspace build; strict TypeScript; ESLint; isolated LLVM/V8 coverage against full base `63d3df17a6f2bebae5522c09fa194657ca86b51b` | Production build/typecheck/zero-warning lint, Rust/Nix formatting and all-target Clippy pass; 854 Rust and 5,150 Vitest tests pass, plus required native/CLI/coverage-checker execution. Contract 140/140 and Actual integration 102/102 pass with no skipped tests. All 29 CLI scenarios, five fault variants and four x86_64-linux Nix checks pass. |

### Current coverage gate

Coverage uses the existing package and changed-file aggregate thresholds; no threshold was reduced. Source-free contract/integration workspaces report **N/A**, not fabricated 100% line coverage; their complete successful, nonempty, unskipped execution is enforced separately.

| Production surface | Covered / executable lines | Coverage | Changed aggregate |
| --- | --- | --- | --- |
| financial-core | 9,481 / 9,916 | 95.61% | 95.94% |
| core-protocol | 5,868 / 6,072 | 96.64% | 97.78% |
| node-binding | 347 / 367 | 94.55% | 94.55% |
| protocol-generated | 468 / 481 | 97.30% | 97.30% |
| Actual adapter | 1,186 / 1,357 | 87.40% | 87.76% |
| Application | 3,933 / 4,459 | 88.20% | 88.96% |
| Inference | 351 / 371 | 94.61% | 94.54% |
| Workflow store | 4,500 / 5,313 | 84.70% | 85.52% |
| Web | 8,033 / 9,657 | 83.18% | 84.51% |
| CLI | 750 / 852 | 88.03% | 88.03% |
| Scenario kit | 1,952 / 2,308 | 84.58% | 85.66% |
| Coverage checker | 446 / 446 | 100.00% | N/A |
| Weighted workspace | 37,315 / 41,599 | 89.70% | Package aggregates above |

## Tests and exit criteria

- Fixed-calendar tests cover ordinary cadence, month boundaries, leap years, weekends, public holidays, and business-day displacement.
- Sparse-input tests verify conservative degradation and mandatory `insufficient_data` outcomes.
- Entity-resolution tests cover aliases, punctuation, imported-payee variants, duplicate payees, conflicting evidence, and explicit user overrides.
- Recurrence tests cover weekly, monthly, annual, irregular, and multiple-occurrence patterns with amount variance.
- External-provider tests cover disabled policy, redaction, cache hits, expiry, rate limits, cost limits, malformed results, provider outage, deletion, and fallback to local-only evidence.
- Every displayed external claim includes provenance and expiry.
- Native Actual rule exports remain valid and executable without BalanceFrame.
- Disabling all enrichment providers does not block synchronization, review, proposal approval, rule execution, or recovery.
- Shared-evidence contract tests distinguish source observations, normalized evidence, semantic suggestions, deterministic rules, ledger proposals, and execution results; verify merchant/payee taxonomy and provenance compatibility with Phase 11.5 without allowing enrichment to assert transaction identity or monetary relationships.
- Canonical fixture round-trips cover the new source fields, absent/unsupported states, schema versions, stable-ID rule semantics, stale proposals, and source/payee/category changes across JSON Schema, TypeScript, Rust, and Actual.
- Refresh an alias, holiday version, policy, or expired provider record while keeping the transaction/category unchanged; require an updated authorized explanation, preserved rejection/correction state, and rejection of stale late results.
- Authorization tests cover private-to-shared evidence leakage, scoped history/alias learning, cache hits after revocation, export/notification access, policy administration, and rules affecting unauthorized transactions. Provider tests include malicious merchant text, unsafe source links/redirects, oversized payloads, and credential-safe failures.
- Use sentinel secrets and merchant queries to verify failed requests, redirects, application/proxy/access logs and traces, cache/provenance/export, and browser errors expose neither credentials nor raw query text. Test same-merchant cross-budget learning, delegated-authority revocation, and concurrent conflicting confirmations.
- Deterministic concurrency tests cover duplicate requests, multiple workers, atomic quotas, fractional-cent accumulation, UTC window boundaries, timeout/crash ambiguity, and disable/delete/revoke while requests are in flight.
- Evaluate the held-out sparse-transaction set against the quality gates above before claiming improvement; report baseline versus new precision, correct coverage, abstention, false alias matches, and recurrence false positives with sample counts. No improvement claim from increased non-empty suggestions alone.
- Benchmark the history sizes, memory, and p95 latency targets above; verify bounded provider calls and no per-candidate full-history scans. Publish measurements, the reference environment, and any pre-implementation target adjustment with exit evidence.
- Browser acceptance uses a disposable Actual fixture with authentication bypass disabled: Sync succeeds, authorized evidence is visible, alias/pattern confirm/reject works, native-rule simulation shows exact affected IDs, and disabled/outage states retain usable review. Exercise policy/cache revocation and a scoped second actor; submit mutations only in scenarios specifically verifying them. Require equivalent CLI/API authorization and evidence semantics.
- Follow repository TDD and coverage gates; retain failing-before/passing-after regressions for existing paths changed by this phase. Local behavior must pass with every external provider absent. Upgrade/restore and deletion tests must include an existing database, not just a fresh schema.

**Exit:** measured local categorization improvement meets predeclared precision/coverage criteria without weakening explicit overrides or authorization; recurrence/calendar reasoning is conservative and fixture-backed; performance and concurrency bounds hold; optional enrichment passes privacy, lifecycle, and cost controls; and every accepted rule executes natively outside BalanceFrame. A passing provider demo or unit suite alone does not establish phase completion.

## Sources

- [VALUE SERP API overview](https://docs.trajectdata.com/valueserp/search-api/overview)
- [VALUE SERP pricing](https://trajectdata.com/serp/value-serp-api/pricing/)
- [actual-ai project and feature description](https://github.com/sakowicz/actual-ai)
- [actual-ai free web search implementation](https://raw.githubusercontent.com/sakowicz/actual-ai/master/src/utils/free-web-search-service.ts)
- [DuckDuckGo acceptable-use policy](https://duckduckgo.com/acceptable-use)

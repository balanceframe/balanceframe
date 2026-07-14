# Phase 0 — Actual baseline and technical proof

**Status:** Active

## Objective

Prove that BalanceFrame can use unmodified Actual through the published `@actual-app/api`, and prove the Rust–TypeScript financial boundary, before building product workflow or relying on a model.

Actual is authoritative for accounts, transactions, categories, envelope budgets, rules, schedules, reconciliation, sync, import/export, and ordinary budgeting UI. BalanceFrame must not fork Actual, use Actual AI at runtime, patch upstream to evade a product decision, or shell out to an Actual CLI.

## Deliverables

### Representative test environment

- Operate stock Actual manually and establish representative accounts, categories, category groups, payees, rules, schedules, transfers, splits, manual transactions, imported transactions, cleared/reconciled states, and envelope budgets.
- Build sanitized fixtures and measure direct-Actual manual categorization time as the later review-workflow baseline.
- Include a data-quality fixture with stale accounts, missing expected coverage, duplicate candidates, pending transactions, uncategorized exposure, transfers, splits, deleted/renamed categories, and version-changed records.
- Establish fixture policy for pending/uncleared/uncategorized transactions, snapshot age, bank-sync age, account overrides, and inclusion scope.

### Actual public API proof

Using an unmodified Actual server and published API, prove:

1. connection to a remote existing Actual instance and budget discovery/selection;
2. encrypted and unencrypted download, synchronization, isolated cache lifecycle, cleanup, and disconnect;
3. reads of accounts, categories, payees, transactions, rules, schedules, budget months/amounts/carryover/holds, tags, notes, and supported ActualQL/batch facilities;
4. uncategorized transaction discovery and a strict Observe mode that permits no writes;
5. disposable-budget bank sync; update of one transaction category; creation/removal of a test rule; and observation of Actual automatic rule learning after API updates;
6. `importTransactions` dry-run behavior, reconciliation of a manual transaction with a matching import, duplicate imported IDs, rule-normalized payees, and export/restore;
7. concurrent reads with a serialized per-budget write stream, interruption/retry behavior, and supported Actual version compatibility.

Proceed only if the public API supports the MVP without a fork and synchronized local-cache lifecycle is manageable. Reconsider rather than work around it if required operations use internals, version coupling is operationally unreasonable, or synchronization conflicts cannot be controlled.

### Rust–TypeScript foundation

- Prove the prebuilt N-API addon loads in supported container targets. Use stable Rust, pure-core `#![forbid(unsafe_code)]`, checked arithmetic, explicit time/ID inputs, panic containment in the thin binding, and classified errors.
- Define Rust-owned serde-compatible protocol types; generate JSON Schema, TypeScript types, and TypeScript runtime validators. Validate before native calls and inside Rust.
- Use immutable normalized snapshots, never raw Actual objects. Encode money as `{ "minorUnits": "1482", "currency": "USD" }`; use opaque string IDs, canonical UTC timestamps, correlation IDs, explicit protocol/schema versions, canonical encodings, shared fixtures, and unknown-field compatibility rules.
- Establish fixture round trips through JSON Schema, TypeScript, Rust, and N-API; test deterministic reproduction, canonical hashes, malformed-protocol fuzzing, and binding panic containment.
- Produce tested Linux x86-64 and ARM64 artifacts through release automation. The application/container starts without a Rust compiler or build toolchain.


## Initial repository structure

```text
project/
├── Cargo.toml
├── package.json
├── apps/
│   ├── server/
│   ├── web/
│   └── cli/
├── packages/
│   ├── actual-adapter/
│   ├── application/
│   ├── workflow-store/
│   ├── inference/
│   └── protocol-generated/
├── crates/
│   ├── financial-core/
│   ├── core-protocol/
│   └── node-binding/
├── protocol/
│   ├── json-schema/
│   └── fixtures/
└── tests/
    ├── contract/
    ├── actual-integration/
    ├── scenario/
    └── end-to-end/
```

The `financial-core` crate begins with modules for money, snapshots, data quality, categorization, merchant normalization, reconciliation, suggestions, mutation plans, rules, and policy. Do not create a crate per module until APIs or portability boundaries stabilize.

## Actual AI relationship

Actual AI is an inspiration and possible source reference, not a runtime dependency. This avoids two competing categorization workflow engines and avoids redesigning Actual AI's central mutation behavior through a fork.

Ideas to borrow:

- sync before classification;
- scheduled classification;
- dry-run-first behavior;
- classify against existing categories before proposing new ones;
- optional merchant research;
- model-provider abstraction;
- OpenAI-compatible endpoints;
- rerunning misses;
- rate limiting and timeouts;
- prompt customization;
- useful transaction context: amount, direction, description, payee, imported payee, date, cleared, and reconciled state;
- reducing model calls through deterministic rules.

Patterns not to copy blindly:

- transaction notes as the workflow database;
- conflating suggestion generation and mutation;
- early automatic category creation;
- model response as authorization;
- model-reported confidence as calibrated truth;
- provider behavior leaking into domain logic;
- web research without explicit egress policy.

### License handling for Actual AI code

Actual AI is MIT licensed. Apache-2.0 code may incorporate MIT code if its copyright and license notice are preserved in copies or substantial portions. Repository files must include `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES`. If code is copied or materially adapted: preserve `Copyright (c) 2024 Szymon Sakowicz` and the MIT text; identify source repository and upstream commit; identify affected components; describe modifications; and do not replace the upstream MIT notice with only an Apache header. Ideas and documented behavior may inspire independent code, but direct source incorporation requires notice tracking.

## Primary source references

- Actual API usage and execution model: <https://actualbudget.org/docs/api/>
- Actual API reference: <https://actualbudget.org/docs/api/reference/>
- Actual rules and automatic category learning: <https://actualbudget.org/docs/budgeting/rules/>
- Actual bank synchronization and credential caveats: <https://actualbudget.org/docs/advanced/bank-sync/>
- Actual multi-user support: <https://actualbudget.org/docs/config/multi-user/>
- Actual AI project (MIT, inspiration only): <https://github.com/sakowicz/actual-ai>
- Actual manual transaction merge implementation: <https://github.com/actualbudget/actual/pull/4739>
- Example reconciliation edge case: <https://github.com/actualbudget/actual/issues/7855>

## Engineering boundaries

| Rust owns | TypeScript owns |
|---|---|
| normalized financial types; checked money/currency; snapshot validation; data quality/readiness; candidate eligibility; merchant/history/duplicate evidence; suggestion validation; mutation plans/hashes; postconditions; rule simulation; reason codes | `@actual-app/api`; auth, sync/cache, reads/writes; normalization; providers/egress; identities, spaces, workflow, SQLite, audit orchestration; jobs, HTTP, CLI, web UI, recovery |

Rust has no network, Actual, model, notification, or workflow-database access. TypeScript does not duplicate Rust-owned financial calculations. Actual owns ledger tables; TypeScript owns workflow/approval/audit/job/policy/provider metadata; Rust owns no writable database. No tables are shared.

The planned coarse binding surface is `analyzeSnapshot`, `findCategorizationCandidates`, `validateSuggestion`, `planSetCategory`, `verifyMutation`, and `simulateRule`—never chatty getters, shared mutation, or callbacks into JavaScript.

## Validation and exit

- Test money overflow/currency mismatch; invalid IDs, relations, timestamps, splits, and transfer states; freshness/blocker precedence; and advertised-platform artifact startup.
- Verify backup, restore, export, disconnect, and Actual-independent use before any production write work.
- Confirm every affected conclusion is a visible blocker when the fixture is stale, incomplete, duplicated, or ambiguous.

- Establish OSS repository safeguards before copied-source work: Apache-2.0 `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES`; DCO sign-off; protected branch/PR/CI/review; security reporting; dependency/license/secret scanning; release provenance; and a trademark policy. If Actual AI source is copied or materially adapted, retain its MIT copyright/license, upstream repository and commit, affected components, and modification record; inspiration alone does not require source incorporation.

**Exit:** representative data exists; required Actual capabilities work through the public API without a fork; and the versioned N-API contract round-trips deterministically on supported artifacts.
# @balanceframe/protocol-generated

TypeScript mirrors of the Rust-owned canonical protocol, with runtime Zod validators.

`src/liquidity.ts` exports documented ordinary interfaces for account-aware requests,
facts, evidence, policy, joint scenarios, claims, backing allocations, transfer plans,
settlement records/results, and transfer precondition verification. Public type names
match Rust; records use camelCase and choices use snake_case.

Import types from `@balanceframe/protocol-generated` and strict runtime schemas from
`@balanceframe/protocol-generated/validators` using the lower-camel type name plus
`Schema` (for example, `accountAwareSpendabilityRequestSchema`, `liquidityFactsSchema`,
`transferPlanSchema`, or `verifyTransferPreconditionsRequestSchema`).

Money minor units are canonical bounded signed-i64 decimal strings. Missing facts
never default to complete evidence. `FinancialSnapshot.liquidity` and
`PurchaseEvaluation.accountAware` are additive nullable/optional fields, so old
canonical snapshots remain readable without asserting account readiness.

These are trusted native/service contracts, not public HTTP input authorization.
Arithmetic, routing, allocation, and plan identity remain Rust-owned.

Merchant text evidence uses five strict availability states: `unavailable`
(not admitted), `unsupported` (the source has no field), and `absent` (an
admitted field has no value) require null; `empty` requires `''`; `present`
requires a nonempty bounded string. Unavailable never asserts absence and
never carries private raw values. The TypeScript types, Zod schemas, and
`protocol/json-schema/merchant-intelligence-v1.json` share this vocabulary.

Merchant aliases may scope `sourceField` to `payeeName` (independently admitted
native display evidence) or a canonical raw text field. Raw-source view masks
do not govern native payee names; aliases never replace native payee IDs.

Observed recurrences require `firstDate` and `lastDate`: authoritative civil-date
endpoints over the complete admitted observation set. Bounded `dates` samples
may omit either endpoint; samples must remain within the ordered full range.
Consumers must not infer the end of observed history from sampled dates.

Native outcomes use three required, nonrecursive tables. `nativeRuleBlocks`
owns complete scalar-sorted IDs for disjoint compiled predicate/category blocks;
`nativeRuleParts` owns sorted literal `blockIndexes` (parts may overlap).
`nativeRuleSets` uses at most four `orPartIndexes`, four fixed
`andPartIndexes` operands with at most two references each, and one required
`categoryPartIndex`. Its meaning is the category filter intersected with the
OR union plus the four-field AND intersection. AND `[]` means no contribution;
an empty operand becomes `[]` only after original references/order/closure
validate, including references in the discarded branch. Fields remain payee ID,
payee name, account ID, category ID. All sets must be used and have a nonempty
literal witness. Bulk readers retain references without expanding unions.
Selected resolution returns every unique matching ID in scalar lexical order.
Merchant owners enforce their existing 256-byte ID and 100000-rule bounds;
generic legacy sources retain their existing string/count contract. Referenced
parts derive from at most thirteen edges per emitted set, not rule count.
All three tables and every outcome survive explanation pagination; legacy
analysis retains proposed category ID/name independently of `maxResults`.

Runtime witnesses probe at most five literal OR/AND candidate domains in
cardinality-ordered rounds; no empty branch can starve another domain's witness.
Overlapping AND slices advance together without constructing their union.
Bounded native evidence merges minimum-scalar-ID
ordered necessary AND routes and stops only when every future block minimum
cannot improve the sample, including interleaved IDs in multi-ID blocks.
Single-field AND routes reuse frozen source-owned weighted category summaries
for counts/advice. These are source postings, not per-outcome histograms or
expanded matching/evidence caches; latency/RSS claims still require measurement.

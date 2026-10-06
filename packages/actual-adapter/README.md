# @balanceframe/actual-adapter

Actual Budget API adapter.

Provides a typed interface to the Actual Budget server API for reading transactions, budgets, and categories.

`ActualConnector.createManualTransaction` is a bounded write port for a separately
approved manual debit or conserved split. It rejects Observe mode, synchronizes
before checking current accounts/categories and imported candidates, uses a
caller-owned stable parent ID, and writes through Actual `addTransactions` once
without inventing a bank `imported_id`. Success requires post-sync re-read of the
exact parent and split children, including category, payee, notes, and absence of
split errors. Ambiguous existing imports and uncertain writes require review;
the adapter never retries an uncertain write or claims that Actual reconciled it.

## Merchant source capture

`ActualConnector.captureMerchantSource(options, consume)` reads raw Actual 26.10
collections sequentially before legacy normalization, then calls `consume` under
the existing budget lock. The trusted application supplies server-computed
admission, horizon, expiry, and a whole-occurrence transaction
cap. It must authorize the complete source dependency closure; admission is not
a client permission grant. Final evidence publication belongs inside the callback.

Capture uses the connector's configured ledger currency (default `USD`), not
Actual display symbols, locale, or merchant-research billing currency. Trusted
capture callers may explicitly override `options.currency`; the standalone
normalizer still requires currency. Readonly `ActualConnector.sourceCurrency`
exposes the configured currency for empty-source zero Money without inventing a
ledger denomination.

`admission.transactionIds` scopes admitted ledger rows; independently,
`admission.sourceTransactionIds` admits raw `imported_payee`, `notes`, and
`imported_id` only for exact listed transaction IDs, and `admission.sourceAccountIds`
must independently admit each transaction's actual account ID. An empty array
in either mask denies raw fields; omitted/null retains compatibility for privileged
full-source callers. The application always supplies its server-computed masks. Denied raw
properties are not read or validated, and are masked before duplicate comparisons,
source hashing, or derived evidence: imported payee/notes become
`{state: 'unavailable', value: null}`, and imported ID becomes null. Native payee
IDs, native payee names, amounts, and other independently admitted ledger facts
remain available. Raw fields on rows outside ledger admission/horizon are also
never read, even for privileged raw-source masks. Admitted malformed raw text
still fails validation.

Text `unavailable` means the field was not admitted and says nothing about its
existence or contents. It differs from `unsupported` (no SDK evidence field),
`absent` (admitted but no value), `empty` (admitted empty string), and `present`
(admitted nonempty string); only null is valid for unavailable/unsupported/absent.

`admission.ruleIds` independently admits native rule content by exact rule ID.
Omitted/null is reserved for proven full-rule-namespace authority and retains SDK
completeness. Explicit arrays are scoped: empty means unavailable rule content;
nonempty means partial coverage (or unavailable when the SDK read is unavailable),
even if all currently known rules match. Coverage and hashes therefore cannot
reveal whether denied rules exist. Denied rule terms, names, and other content
are never read, validated, compared, or hashed. Account/category-incompatible
admitted rules are excluded and cannot assert complete coverage. Rule and raw
transaction/account masks are trusted internal input, not fields or authority
assertions in canonical `sourceAdmission`.

`normalizeActualMerchantSource` preserves stable IDs, exact safe-integer minor
units, raw imported payee/notes availability, tombstones, native starting-balance
flags, transfers, and distinct unavailable/partial collection coverage. Nested
and flat split children deduplicate; missing, hidden, ineligible, or capped
siblings cannot establish a complete recurring occurrence. Title/description
are unsupported SDK evidence; uncleared is not pending. Source hashes exclude
capture/expiry timestamps and incidental collection order, but preserve native
rule execution order. Scheduled expectations reuse the liquidity normalizer
without inventing observed amounts or cadence.

Merchant holiday lookup is offline and explicitly configured by budget/account.
It uses checked-in `packages/application/src/merchant-calendar-data.json` from
MIT `python-holidays==0.105`, covering national and official US/CA/GB subdivisions
for 2020–2035 with public observed holidays. Regenerate using
`scripts/merchant-intelligence/generate-calendars.py --sdist <holidays-0.105.tar.gz>`
inside the pinned Python environment; the generator checks the source archive
SHA-256 and installed source and embeds full license/contributor attribution.
No Python, subprocess, network, locale inference, or bank-closure assertion is
part of runtime lookup. An explicit null account override disables the calendar;
unsupported selections/years stay unknown instead of falling back nationally.

## Account-aware liquidity

`ActualConnector.synchronize()` adds normalized `FinancialSnapshot.liquidity`. Current
category availability comes directly from Actual `getBudgetMonth` category `balance`,
not assigned budget minus transactions. Future availability is the source `budgeted`
additional assignment, not the projected balance that already contains carried current
cash. Missing future assignment stays unavailable. Current/future periods retain their
source month and disjoint `cashBucketId` while preserving stable `categoryId` and
independent category semantics. Signed unsettled flows preserve inclusion
state and source schedule/transfer links. Unknown account type, currency, ownership,
institution freshness, holds, and card payment facts remain unknown.
Source-declared income categories remain in the legacy/source entities but are excluded
from liquidity cash buckets: they are not spendable expense envelopes. Missing expense
availability still remains unavailable and blocks unsafe conclusions.
The global `account_collection_coverage` observation records only whether account
enumeration succeeded, including an empty collection. Failed enumeration stays unknown.
It does not upgrade legacy `coverage.accounts` or missing per-account type, balance, or
freshness evidence; those retain their independent uncertainty.

The root and `/normalizer` exports include:

- `normalizeActualLiquidityFacts`: source collections and explicit read coverage to canonical facts.
- `normalizeActualScheduleLiquiditySource`: exact/approximate/ranged source amounts and stable IDs.
- `normalizeActualTransferSettlementRecords`: signed ledger transfer records with `actual_import` or `manual_ledger` provenance.
- `withLiquidityFacts`: **trusted internal** composition that rehashes the full snapshot and retains `liquidity.ledgerContentHash`.
- `userAttestedLiquidityObservationSchema`: strict public values; no ledger hash or provenance override.
- `bindUserAttestedLiquidityObservations`: after authorization, adds a server-owned per-account
  material fingerprint to `currentLedgerConfirmed: true` before persistence.
- `persistedUserAttestedLiquidityObservationSchema`: validates stored bound observations.
- `mergeUserAttestedLiquidityObservations`: applies persisted observations with original time/expiry,
  rejecting unbound or mismatched confirmations. Changed balance/activity invalidates confirmation;
  a new capture timestamp alone does not. This cannot override recorded ledger balances, impersonate
  institution evidence, or erase existing flows/obligations.

Public handlers must authorize the snapshot's budget/account and load persisted supplemental
observations themselves. Do not expose the full-facts composition API as a public request.
Current-ledger confirmation changes only independent user-attested `freshnessEvidence`;
the balance and its `actual_ledger` evidence remain unchanged.
An explicit governed card declaration may designate an existing current ordinary Actual
category as `credit_payment`. Only semantic purpose changes: its authoritative availability
and ledger evidence remain unchanged. Income, future-only, missing, unavailable, and
currency-incompatible reserve categories are rejected. Native evaluation still owns
authorization, payment cash reservation, and prohibition on spending the reserve as an
ordinary purchase category.
This stable category purpose also applies to its existing future facts, without altering
their source assignments, evidence, or period.
Manual transfer links alone do not prove settlement. Actual import IDs preserve Actual
import provenance, not provider confirmation; Rust verifies both reconciled imported sides.
Linked incoming credits remain unsettled until independently imported and reconciled,
even if manually marked cleared. Current-ledger confirmation cannot release those flows;
ordinary cleared manual transactions are unaffected.
`LedgerSnapshotResult.transferSettlementRecords` carries those trusted normalized
source records from synchronization before transfer links are lost. Legacy adapters
may omit it, meaning unavailable evidence; an array must still be interpreted with
the snapshot's collection coverage. Actual `occurredAt` retains its calendar date,
while `observedAt` is the precise capture instant.
Actual does not expose an independent reversal-status field. The adapter does not infer
reversal from descriptions, opposite amounts, or unrelated transfer pairs.
Exact one-time schedules retain their source date and known coverage. Recurrence
configuration and signed ranges remain typed in `liquidity.schedules`; this snapshot
normalizer has no evaluation horizon for recurrence expansion, so recurring coverage
is explicitly unsupported rather than guessed complete.
Schedule links discharge a whole obligation only when distinct same-account/date links
sum to its exact signed amount; payment additionally requires the exact cleared total.
Partial, duplicate, overpaid, or wrong-sign links produce explicit unknown coverage
instead of fabricated known remaining capacity.

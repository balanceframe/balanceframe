# @balanceframe/actual-adapter

Actual Budget API adapter.

Provides a typed interface to the Actual Budget server API for reading transactions, budgets, and categories.

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

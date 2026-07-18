# Fixture Policy

> Status: Phase 0 — Representative test environment
> Applies to: `protocol/fixtures/*.json`
> Schema: `protocol/fixtures/representative.schema.json`

## 1. Pending / Uncleared / Uncategorized Distribution

Transactions in fixture snapshots follow a fixed distribution relative to the full population:

| State | Fraction | Definition |
|---|---|---|
| Uncategorized | 40% | `categoryId` is `null` |
| Pending | 20% | `importedPayee` is set AND `cleared` is `false` AND `reconciled` is `false` |
| Cleared | 30% | `cleared` is `true` (regardless of `reconciled`) |
| Both (uncategorized + pending) | 10% | `categoryId` is `null` AND `importedPayee` is set AND `cleared` is `false` |

The 10% "both" overlaps with the 40% uncategorized and 20% pending. All four states are measured against the total transaction count (excluding sub-transactions, which inherit their parent's state).

### Rationale

Uncategorized transactions constitute the primary backlog that the review workflow addresses. Pending transactions represent recently imported items awaiting human review. The 10% overlap captures the common real-world case where imported synced transactions arrive without a category assignment. Cleared transactions are included to provide a realistic baseline of an already-managed budget. Transfers and splits are counted separately but carry their own state derivations.

## 2. Snapshot Age

- All snapshot dates and transaction dates fall within a **7-day window** ending on the reference date (`snapshot_date`).
- The reference date is `2026-07-15T00:00:00Z` for all Phase 0 fixtures.
- Transaction dates range from `2026-07-08` through `2026-07-15` (inclusive).
- This ensures freshness analysis and stale-data blocking logic can be tested against a compact, well-defined time window.

## 3. Bank-Sync Age

- Approximately one third of accounts use actual bank-synced transaction data (marked with `bank_sync: true`).
- The remaining accounts carry manually entered transactions (`bank_sync: false`).
- Synced accounts carry transactions with `importedPayee` set for the majority of those transactions; manual accounts rarely set `importedPayee`.
- This variety tests the gateway's ability to extract and normalize payee information from both import sources.

### Synced accounts
- `a_1` (Checking)
- `a_2` (Savings)
- `a_3` (Credit Card)

### Manual accounts
- `a_4` (Cash Wallet)
- `a_5` (Investment Portfolio)
- `a_6` (Car Loan)
- `a_stale` (Stale Wallet)
- `a_excluded` (Excluded Account)

## 4. Account Overrides

Certain accounts carry non-standard `transferFrom` / `transferTo` values that override the default transfer account mapping:

| Account | Override |
|---|---|
| `a_3` (Credit Card) | `transferFrom` set to `"a_1"` — credit-card payments pull from checking |
| `a_1` (Checking) | `transferTo` set to `"a_6"` — loan payments originate from checking |
| `a_5` (Investment) | No override; uses system default |

These overrides test that transfer identification and account-type inference correctly respect per-account overrides rather than assuming a single global transfer partner.

## 5. Inclusion Scope

- Every account, category, payee, and transaction is included in the snapshot **unless** it carries `isExcluded: true`.
- Excluded accounts appear in `accounts[]` with `isExcluded: true` but their transactions are omitted from the snapshot.
- This ensures the gateway correctly honors the exclusion flag and does not silently include excluded data.
- Only one account (`a_excluded`) is excluded across all fixtures.

## 6. Duplicate Candidates

Duplicate candidates are defined by:

- **Same absolute amount** (`amount` matches in `minorUnits`).
- **Date within ±1 day** of each other.
- **Similar normalized payee name** (Levenshtein distance <= 2 after lowercasing and stripping non-alphanumeric characters OR shared substring with minor differences such as "LLC" vs "L.L.C.").

Example pair:
- `payeeName: "AMAZON MKTPLACE"` on 2026-07-10 for -2399
- `payeeName: "Amazon Marketplace"` on 2026-07-11 for -2399

Fixtures include at least one set of duplicate candidates. The deterministic rule engine must identify these as potentially duplicated and surface them for review rather than silently consuming both.

## 7. Stale Accounts

At least one account in the fixture has a balance that has not been reconciled for **90+ days**:

- Account `a_stale` (Stale Wallet) has its `lastReconciled` set to `"2026-04-01"` (105 days before the reference date).
- Its `clearedBalance` is unchanged between that date and the snapshot date.
- The stale-account check must flag this account's balance as unreliable for envelope-availability calculations.

## 8. Transfers

- At least 4 transactions carry a non-null `transferAccountId`.
- Transfers appear in pairs: the originating transaction (in the source account) and the receiving transaction (in the target account).
- Transfers have `categoryId: null` and `payeeName` pointing to the counterpart account.
- The gateway must detect transfer pairs and exclude them from uncategorized analysis.

## 9. Splits

- At least 3 transactions carry `subtransactions: [...]` with multiple entries.
- Each sub-transaction has its own `amount` (Money) and `categoryId`, and the sum equals the parent's `amount`.
- Splits must be tested to ensure the gateway correctly drills down into sub-totals for envelope-budgeting.

## 10. Deleted / Renamed Categories and Version-Changed Records

### Deleted categories
- A deleted category appears in `categories[]` with `deleted: true` and `version >= 2`.
- At least one transaction references this deleted category via `categoryId`.
- The fixture consumer must detect the reference to a deleted category and surface it as a data-quality concern.

### Renamed categories
- A renamed category appears with its current `name` and an `oldName` metadata field recording its previous name.
- At least one transaction references the renamed category.
- The consumer may optionally flag the rename for user awareness.

### Version-changed records
- Categories with `version > 1` and `deleted: false` represent records that have been modified in the ledger since the initial import.
- These test that the snapshot correctly carries version metadata and that the consumer can detect mutated records.

---

## References

- [Phase 0 — Actual baseline and technical proof](00-actual-baseline-and-technical-proof.md)
- [Representative fixture](../protocol/fixtures/representative.json)
- [Data-quality fixture](../protocol/fixtures/data-quality.json)
- [Fixture JSON Schema](../protocol/fixtures/representative.schema.json)

# Transaction evidence review

This feature is being developed for v0.9.0. See the
[acceptance status](roadmap/post-mvp/11-5-implementation-status.md) for unfinished
release requirements. Email forwarding is deferred.

## Add a receipt

1. Select the intended space and disposable or authorized budget, then open
   **Review → Transaction evidence**. Your current membership and source grants
   determine what you may import and read; importing never grants access.
2. Choose **Take a receipt photo or choose an image**. On a supporting phone this
   offers the camera. JPEG and PNG images are limited to 5 MiB.
3. Enter the visible receipt date, currency and exact total. Purchase and refund
   directions are explicit. Optional item entry accepts the quantity, unit gross,
   line gross, discount, tax and net exactly as printed, plus each payment tender.
   Enter explicit zeroes only when known. No balancing amounts are invented.
4. If installed, **Read photo text (optional)** returns unverified local OCR text.
   Check it against the photo. It never fills financial facts or writes to Actual.
   Manual entry remains available while extraction is absent, offline or failing.
5. Save the evidence, load the sources you are permitted to read, and resolve
   them. Missing items and inconsistent totals remain unresolved. You may save a
   photo with summary facts alone when complete item details are unavailable.

The advanced file controls also accept versioned wallet/retail JSON extractions
and uploaded PDFs. For a retail PDF, select **Enter receipt details now** to use
the same exact manual summary/item/tender form. PDF OCR is not offered. Sources
without entered facts remain retained awaiting extraction. Manual normalization
does not authenticate an issuer, establish a wallet balance, or authorize an
Actual write.

## Review the ledger consequence

Use current permitted account/category names and settlement details to review a
candidate match. An existing settlement keeps its account, amount, posting date,
payee, notes, imported provenance and supported split identities. Its category
or exact split may change through a separate governed amendment proposal.
Reconciled transactions, transfers and unsupported split reshaping are refused.

For a conserved receipt, categorize the nonzero items individually. Free items
remain visible without creating zero-value financial splits. **Use approved item
suggestions** explicitly checks current exact rules and shows their provenance.
Conflicts stay in manual review; an unavailable rule service leaves category
selection usable. Suggested categories do not change receipt amounts.

When several whole receipts belong to one existing bank payment, open
**Allocate receipts to one existing settlement**. Select the receipts, account,
current payment and each item's category, then preview the exact allocation.
Rust checks the receipt, tender and settlement totals; the browser supplies
selections rather than financial amounts. Confirm the preview with a fresh
human session, then create the ordinary amendment proposal. This preserves the
existing payment and creates no additional transaction.

For partial item allocations or several settlements, open the receipt allocation
matrix. Select current receipts and permitted existing Actual payments, choose
each item's account/category context, and enter exact contributions to each
payment in minor units. Rust previews output splits and unresolved remainders.
Saving requires fresh human confirmation. The ordinary proposal displays exact
native cells and source hashes before independent approval. Unwritten new
transactions and refunds are not matrix destinations in this version.

Confirm an exact evidence decision with a fresh human session, then choose
**Create exact ledger proposal**. Review its payload and ordinary approval
requirements on the proposal page. Credits/refunds preserve their explicit
direction; a received payment never defaults to income. Nothing in import,
OCR, matching, rule suggestions or evidence confirmation automatically executes
a financial mutation. Source changes require a new resolution and proposal.

Saved Spend Sessions can be handed off as pending evidence. Open the receipt
comparison after import, choose a current receipt, and explicitly review item
mappings, substitutions, omissions and extra items. Choose complete coverage
only when the receipt really covers the session; unknown quantities, estimated
prices and different currencies stay visible. Fresh human confirmation saves
the comparison against the exact session version and receipt. It does not
complete the session or change Actual. Existing completion references remain
separate, and planned prices remain planned.

Explicit receipt-item categories retain their source and human-review
provenance. Repeated matching outcomes from distinct sources may offer an exact
merchant, account, funding and item rule candidate. Inspect its examples and
conflicts, run the ordinary simulation, then approve its exact payload before
it can suggest categories. Imported category claims and repeated delivery of
the same source cannot train a rule. A later correction or revocation withdraws
the old training outcome.

## Local wallet statements

Open **Review a local wallet statement**, select an authorized original, retrieve
and inspect its exact bytes, and select a source-scoped wallet or printed label.
Enter the inclusive statement dates, currency and known boundary balances.
Preview native interval activity and its exact manifest, then explicitly confirm
the printed claims and complete activity with a fresh human session. This is
human-attested evidence, never provider-authenticated evidence. Missing or
conflicting coverage stays explicit and blocks dependent work. Source health
shows native balance state and continuity reasons alongside individual statement
intervals; covered intervals separated by a gap do not imply a known balance.

An admitted positive opening boundary offers **Prepare opening equity proposal**.
Select the exact native boundary and new Actual account name. The server derives
its amount, currency and proof. The ordinary proposal requires independent
approval and execution, and verifies Actual's real starting-balance transaction
and account balance. Opening equity is distinct from income/refunds. Revocation
remains available after original bytes expire.

## Receipt relationships and versions

Receipt review links exact return lines to original purchases, associates
fulfillment with an order, and attributes items to authorized membership periods.
Clear incorrect relationships before replacing them; clearing remains available
when overlinked returns fail conservation. An order alone never establishes
settlement.

Version review selects a current replacement and independently readable
predecessor. Inspect the native preview and confirm they describe the same
receipt. Reviews bind document/hash/parser/receipt identity and the admitted
predecessor chain. Revoking predecessor access withdraws affected child authority
and creates attention; unrelated receipts remain usable. Revoke the reviewed
link separately when correcting it. Stored extraction is unchanged.

## Privacy and limits

Raw bytes are encrypted separately from normalized claims, retained for seven
days by default, and protected by a distinct source-read grant. Authorized raw
deletion preserves permitted normalization and content-free audit. Expiry and
restore quarantine prevent deleted bytes or old decisions becoming usable again.

Complete evidence-operation JSON is limited to 16 MiB; OCR request JSON to
7 MiB. Each receipt permits at most 1,000 lines and 100 tenders. Rust validates
money, quantities, conservation and projection postconditions. Source text cannot
invoke tools, change policy or grant authority. Health shows visible receive/parse
status, duplicates and current native statement coverage when admitted proof
exists. Absent proof stays unknown. External provider freshness is not inferred
from a local upload.

The [optional OCR setup](receipt-ocr.md) adds a disabled-by-default Compose
service. The default installation and core health do not require OCR.

## CLI selectors

Evidence commands use the configured server and selected space. For example:

```sh
balanceframe evidence list --json
balanceframe evidence health --json
balanceframe evidence resolve --json
balanceframe evidence settlements --file settlement-selector.json
balanceframe evidence proposal --file proposal-selector.json
balanceframe evidence allocation-preview --file allocation-selector.json
balanceframe evidence allocation-save --file confirmed-allocation.json
```

The settlement selector contains only `resolutionHash`, `eventId` and
`accountId`. The proposal selector contains only `resolutionHash` and `eventId`.
Use values from the current authorized resolution. The server prepares the exact
financial action; caller-authored financial effects, actor IDs and policy
versions are rejected. Creating a proposal does not execute it. Evidence and
item-rule decisions requiring human confirmation use the existing authenticated
human-session transport.

An allocation selector contains `resolutionHash`, `targetTransactionId`,
`receiptIds` and explicit `lineCategories` entries (`receiptId`, `lineId`,
`categoryId`). Confirmation includes the exact returned `allocationHash`.
The server re-reads current permitted evidence and recomputes the native plan;
caller-supplied amounts, effects and provenance are rejected.

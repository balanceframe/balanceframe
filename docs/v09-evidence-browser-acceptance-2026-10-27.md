# v0.9 slice 2: unverified evidence controls

**Blocked: receipt-version revocation, wallet-statement invalidation and saved
Spend Session receipt comparison have no completed browser acceptance here.**
This is a focused handoff, not a passing test receipt. It stacks on the
[slice 1 diagnostic and recovery handoff](v09-plural-browser-acceptance-2026-10-27.md).
The same single Chromium sandbox failure blocks all three paths; no second
browser attempt, sandbox workaround or application fixture was started for
this slice. No runtime code or security controls changed.

Source reconciled: main `6fe0c2d4075d841bdc45d9d12ecda2e7a24df265` plus slice 1
`d79943cbe39d8f9639110323ac555a3203626aad`. Scope is the three outstanding
browser paths below. Existing intake, preview and session-creation browser
journeys from the [beta audit](beta-ui-audit-2026-10-23.md) do not need to be
repeated as separate acceptance goals.

## Reconciled evidence

| Path | Existing supporting evidence, not rerun in this slice | Actual missing observation |
| --- | --- | --- |
| Receipt versions | The beta audit opened evidence previews. `packages/scenario-kit/test/acceptance/evidence-receipts.test.ts` exercises version 2 preview/save, stale-hash denial, loss of the exact predecessor grant, child withdrawal with unrelated evidence retained, grant restoration and relationship revocation. Web component/server and application receipt-version tests cover input/proof invalidation. | Operate these controls in an authenticated source browser, observe current-source invalidation and the final revoked relationship after reload. The beta audit did not record this flow. |
| Wallet statements | The beta audit previewed claims; it explicitly did not attest a statement. `packages/scenario-kit/test/acceptance/evidence-wallet-categorization.test.ts` covers imported authority unknown, exact fresh human attestation, known balances, gap/conflict and revocation with Actual unchanged. Component/API tests cover guarded controls and revocation. | Browser attestation and revocation must actually withdraw visible authority and dependent opening eligibility. A wallet preview or SDK opening-equity test does not establish this. |
| Session comparison | The beta audit created/evaluated a session and prepared a completion. `packages/application/test/spend-session-receipt.test.ts`, `apps/web/test/pages/spend-session-receipt.test.ts`, server routes, workflow-store tests and canonical protocol fixtures cover server archives, mappings, fresh confirmation, source/version fences and association exclusivity. | Browser import of a current saved session, explicit receipt comparison/save/reload and stale-context denial. Earlier session creation/completion readiness did not exercise receipt comparison. |

The [implementation status](roadmap/post-mvp/11-5-implementation-status.md)
correctly keeps authenticated browser validation open. Scenario verification
records (`backend: disposable-actual`, `auth: better-auth`) are service/API
evidence, not a browser result. The eight synthetic evidence fault cases
explicitly report `actualWrite: false`; they do not close these gaps either.

## Receipt versions: permitted-host procedure

After the normal source build, on a host where an ordinary sandboxed browser
has already passed preflight, use the existing owned supervisor:

```bash
pnpm demo --scenario evidence-return-lifecycle
```

Open the printed loopback URL, select the genuine owner persona and open
`/review#transaction-evidence`. Record this generation's budget, space,
owner/membership, purchase/replacement/unrelated document and receipt IDs.
Use the normal exact source/evidence grants; authenticate with the real demo
session, development bypass false, and guarded `CONFIRM` proof. Capture an
independent Actual SDK baseline. Do not submit any financial proposal.

1. Expand **Review receipt or invoice versions**, then **Load readable receipt
   versions**. Select the replacement as **Newer receipt** and the exact
   purchase as **Older receipt**. Preview version 2 replacing version 1;
   record both source hashes and the displayed source closure. Save requires
   the same-receipt acknowledgement and fresh human confirmation.
2. In the owner-controlled `/spaces` grants UI, revoke only the predecessor
   document's `normalized-evidence` capability for this actor. Reload current
   evidence/history. Require the dependent replacement to be withdrawn/blocked,
   focused attention to explain the stale history, and the unrelated receipt
   to remain usable. An old selection cannot save against the changed fold.
   Do not broaden account/budget grants to clear this expected refusal.
3. Restore that same exact fixture grant through the ordinary handler. Reload
   current history, choose **Remove a reviewed relationship**, select the owned
   newer receipt and explicitly confirm removal. Observe the successful revoke
   response and refreshed history. Reload the page and load history again:
   the relationship is absent, blocked children are cleared, and purchase,
   replacement and unrelated receipts remain independently readable.
4. Compare the full Actual SDK baseline: accounts, balances, transaction IDs,
   amounts/splits, notes/imported metadata and native rules are unchanged.

Revocation removes a reviewed link. It does not delete the older receipt,
recover expired photos or grant new access. Use current rendered choices and
returned hashes; the old baseline audit's phrase “revoke the old version” must
not be interpreted as a document-deletion operation.

## Wallet statement: permitted-host procedure

Stop and clean the previous owned supervisor, then start a fresh fixture:

```bash
pnpm demo --scenario evidence-wallet-statement
```

Record the new generated budget/space/source document/wallet and owner IDs.
Open `/review#transaction-evidence` as its genuine owner, expand **Review a local
wallet statement**, and **Load current statement choices**. Imported JSON may
declare balances/activity, but it must initially show `balance_unknown` and no
human proof. Record an independent full Actual SDK baseline.

1. Inspect the authorized original source. Enter its exact interval, wallet,
   USD opening 200 and closing 100 minor units; the source activity is an
   outflow of 100. Preview must bind the exact source identity/hash and activity
   manifest and say `human_attested_statement`. Require both original-content
   and complete-activity acknowledgements plus fresh human confirmation before
   saving. A missing acknowledgement cannot enable saving.
2. Observe known opening/closing balances 200/100, the attributed current proof,
   and eligible opening anchors. Do not prepare or execute opening equity in
   this evidence-only path. Capture the current proof/fold/source hashes.
3. Explicitly acknowledge revocation and revoke that exact proof with fresh
   human confirmation. Reload current choices/resolution/health, then reload
   the page. Require `balance_unknown`, no active authority from the revoked
   proof and no eligible opening anchor based only on that proof. Original
   evidence stays readable under its unchanged grants; revocation is not raw
   deletion. If additional active proofs exist, evaluate their actual coverage
   rather than expecting every wallet to become unknown.
4. The existing API gap/conflict case is supporting evidence. Only if broader
   invalidation acceptance is needed, create its explicit synthetic gap or
   conflicting proof and verify the corresponding unknown/conflict UI; never
   alter existing proof rows or claim provider authority. Keep this result
   separate from the basic attestation/revocation result.
5. The complete Actual SDK baseline remains unchanged, including no new wallet
   account, starting-balance transaction, financial claim or native rule.

## Saved-session comparison: setup prerequisite and browser procedure

**The five evidence demos cannot run this combined path unchanged.** Their
`scenarioFeatureWrite` allowlist does not admit `/api/evidence/spend-session`,
`session-context`, `session-compare` or `session-association`; the catalog has no
dedicated session-comparison acceptance family. `DEMO_OPERATION_DISABLED` here
is an intentional safeguard. Do not add those endpoints to another scenario's
allowlist or suppress the denial just to make this browser test pass.

Use an independently owned source-development fixture following
[AGENTS.md's live-browser setup](../AGENTS.md#live-browser-verification):

```bash
pnpm --filter @balanceframe/actual-integration setup
# After exporting this fixture's isolated configuration and test-only secrets:
NUXT_DEV_BYPASS_AUTH=false \
  pnpm --filter @balanceframe/web exec nuxt dev --host 127.0.0.1 --port 3002
```

Before launch, give auth, workflow, connection and credentials their own private
temporary paths and a stable loopback Better Auth URL/secret. Export
`NUXT_AUTH_DB_PATH`, `BALANCEFRAME_WORKFLOW_DB_PATH`, `BALANCEFRAME_CONFIG_PATH`,
`BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `ACTUAL_SERVER_URL` and
`ACTUAL_SECRET_KEY`; also keep `BALANCEFRAME_DEV_BYPASS_AUTH=false`.
The setup command creates only disposable Actual data. Never reuse an existing
integration `.env.test`/server root owned by another worker. Record the setup's
budget/group/name/port and seed-data provenance without logging secrets.

Create a genuine human session and selected space through the ordinary
setup/governance UI. In `/connection`, explicitly select this fixture budget.
Use ordinary handlers to grant only this actor's required session/account/
category/evidence resources and selected-budget ingest/resolve admission.
`session-context` additionally requires `normalized-evidence`; compare requires
`resolve`, and association save requires fresh human `resolve`. No financial
execute grant is needed. An unresolved bootstrap/grant/selection step is a
blocked setup, not a reason to write private SQLite rows.

1. Through the ordinary session UI, save two fictional items. To match the
   [canonical comparison](../protocol/fixtures/spend-session-receipt.json), use
   quantity 2 with unit reference USD 600 minor units and a second item with
   reference 100. Use the fixture's mapped account/category IDs and current
   timestamps; record the actual server session ID/version. Import a fictional
   receipt through normal evidence ingestion using that fixture's receipt facts
   (total 1200, two units at gross 600). Do not upload its `sessionSnapshot` as
   trusted intent; only the server may archive saved sessions.
2. On `/spend-sessions/<actual-id>`, click **Use saved items as evidence**, then
   **Find current receipts**. Confirm the displayed saved session ID/version
   matches the server archive. Select the actual imported receipt. Compare with
   **Complete purchase**, map the first item to its exact receipt line and mark
   the second **Not purchased**. Require matched/omitted rows, quantity same,
   unit reference 600/600, receipt total 1200 and `comparison_only` authority.
3. Save only after fresh human confirmation of the displayed comparison hash.
   Observe **Comparison saved**, cleared confirmation input and an association
   bound to the actual intent/source/version hashes. Reload the session,
   re-import that same unchanged version through the normal button, and load
   current receipts again; the current reviewed association must persist.
4. Exercise one meaningful invalidation: preview, then change the saved session
   version in another authorized tab before saving. Require an unavailable/stale
   result with no new association. Also verify changing the mapping clears the
   previous preview/save readiness and duplicate receipt-line mapping is refused.
   Partial/unknown coverage must remain explicit rather than silently omitting
   unmapped items. These conditions already have component/service coverage;
   capture their actual browser state to close the UI gap.
5. Compare native SDK and workflow readbacks before/after: no Actual transaction
   or account/rule change, no new financial claim/completion proposal, no session
   completion and no consumed reservation. Planned references stay pending;
   equality with a receipt amount does not confer financial authority.

## Evidence and cleanup contract

For each path record the exact source/native/browser/Actual versions, URL,
fixture generation and IDs, genuine actor/membership and bypass-disabled mode,
grants actually used, action/observable control state, sanitized endpoint
response, page/console errors, source/proof/comparison hashes, and independent
before/after native invariants. Mark each step `passed`, `failed` or `blocked`.
Never infer browser success from a response alone or repeat a mutation after a
lost response; reload/read current state first.

Stop each demo with Ctrl-C and verify its owned temporary root is removed. For
the independent source fixture, close its tabs, stop only the recorded source
web and Actual process handles, verify exit/owned ports closed, then remove its
own temporary state and generated `.env.test`. Confirm no source-tree artifacts,
credentials or unrelated process changes. Keep any retained evidence private
and sanitized. None of these three procedures was executed in this slice;
acceptance and the stable release gate remain open.

# Acknowledged categorization pilot

This is partial integration evidence for the existing delegated categorization
writer. It does not complete slice 7 or qualify read-only Actual access or
lost-acknowledgement recovery. The owner has since approved the synchronization-capable
preview contract in [ADR 0009](adr/0009-synchronization-capable-categorization-preview.md).
That decision does not establish settlement of an uncertain prior dispatch.

`tests/actual-integration/13-delegated-categorization.test.ts` creates an owned
disposable budget from `protocol/fixtures/representative.json`. It uses the normal
`reviewAndApply` SDK path, real SQLite governance and native Rust planning and
verification. SDK synchronization is permitted in this financial-write test.

The contract verifies:

- An exact agent delegation and credential binding, with two distinct human
  approvers. One approval cannot execute; absent parent or agent controls deny
  execution without consuming approvals.
- One explicit human opt-in admits exactly one SDK category update. Native
  verification, consumed approvals, durable success and verified admission match
  the exact proposal. Its original currency and absolute magnitude remain charged.
- Raw Actual transactions, account identities and balances are unchanged except
  for the intended category. Replay after reopening SQLite performs no further
  SDK category update.
- Replacing control versions and the agent credential cannot reset the shared
  operation cap. Raising the cap while stopping the parent independently proves
  stop denial, with no additional admission or consumed approval.

The test freezes **only JavaScript Date**, at its real starting instant, and
restores it after the test. Network and timeout timers remain real. This prevents
UTC midnight from resetting the accounting window halfway through the contract;
it does not disable source freshness, expiry or future-session checks. The
disposable server keeps its own real clock.

Local production-mode checks on 2026-10-27 passed this one contract against both
already-installed server profiles, using SDK client 26.10.0:

| Actual server | Result | Version evidence |
| --- | --- | --- |
| 26.7.0 | 1 passed, 0 failed | Selected fixture executable reported 26.7.0 |
| 26.10.0 | 1 passed, 0 failed | Selected executable plus the `/info` expected-version gate |

Both runs explicitly set `NODE_ENV=production` and
`BALANCEFRAME_ACTUAL_FIXTURE=1`. Each used a fresh owned server fixture, and its
listener was confirmed closed before fixture-data removal. Repository typecheck
and lint passed. A separate strict test-file type probe still reports the
unchanged optional-date argument error in `tests/actual-integration/actual-client.ts:74`;
the normal repository typecheck does not include these integration test files.

Run against the canonical disposable fixture using the owning package's setup,
then explicitly preserve its production execution mode:

```sh
pnpm --filter @balanceframe/actual-integration setup
NODE_ENV=production BALANCEFRAME_ACTUAL_FIXTURE=1 \
  pnpm --filter @balanceframe/actual-integration exec vitest run 13-delegated-categorization.test.ts
```

Select the intended installed server profile before setup; the SDK client version
does not identify the server version. `ACTUAL_EXPECTED_SERVER_VERSION` enables
the existing `/info` version gate. Local verification uses fresh owned fixtures,
not a live budget. Test cache removal occurs only after successful SDK shutdown
and exact remote-budget deletion; a failed lifecycle retains its cache and fails.

These are application-service integration checks with real store credential
bindings and synthetic trusted session contexts. They do not establish Better
Auth transport or browser acceptance. No recovery endpoint, source reader,
settlement witness, quota reset or uncertain-admission clearing was added.

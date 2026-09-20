# @balanceframe/cli

BalanceFrame CLI tool.

Command-line interface for batch operations, testing, and automation.

## Account-aware purchase checks

Production `purchase evaluate` uses the same Rust-backed, resource-scoped application
service as the web purchase check. Configure `BALANCEFRAME_WORKFLOW_DB_PATH` to the
shared workflow database and `BALANCEFRAME_ACTOR_ID` to an explicitly provisioned
current member. The CLI does not impersonate the registered owner or grant liquidity
permissions to the default `usr_cli` identity.

```sh
balanceframe purchase evaluate --category-id food --amount 2000 --currency USD \
  --account-id checking --purchase-at 2026-09-06T12:00:00.000Z \
  --required-by 2026-09-06T12:00:00.000Z --json
```

`--account-id` is optional. The result separately reports category funding and account
payment readiness, with no automatic bank initiation. Category funding alone never
makes legacy `allowable` true. Stale, missing, or unauthorized evidence blocks confident
recommendations; manual confirmations and route policy are governed through settings.

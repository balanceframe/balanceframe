# @balanceframe/cli

BalanceFrame CLI tool.

Command-line interface for batch operations, testing, and automation.

## Authenticated server transport

Production commands use BalanceFrame's authenticated HTTP APIs; governed reads and actions
never load private local workflow stores or Actual credentials. Set `BALANCEFRAME_SERVER_URL`
and either `BALANCEFRAME_API_KEY` for server-verified delegated operations or
`BALANCEFRAME_SESSION_COOKIE` to the current `Cookie` header from the normal sign-in/reauth
flow. The CLI does not keep a cookie jar across invocations: refresh the configured cookie
through that flow when it expires or rotates. Human approvals and control-plane changes
require a server-issued reauthentication proof no older than five minutes; an API key or
delegated agent can never supply that proof.

Select a space with `BALANCEFRAME_SPACE_ID`; if unset, the CLI may use `balanceframe_space`
from the session cookie. An explicit configured space takes precedence and is sent as
`X-BalanceFrame-Space` on scoped requests. The server verifies current membership or exact
live delegation on every request. Spaces begin unbound; credentials and budget connections
remain server-owned. `BALANCEFRAME_ACTOR_ID` and `--actor-id` never select the caller; the
flag is only an audit filter.

```sh
balanceframe spaces list --json
balanceframe spaces create --name "Family ledger" --kind shared --json
export BALANCEFRAME_SPACE_ID=spc_family # use the ID returned by create/list
balanceframe spaces select "$BALANCEFRAME_SPACE_ID" --json
balanceframe spaces policy get --json
balanceframe spaces memberships list --json
balanceframe spaces grants list --json
balanceframe spaces delegations list --json
balanceframe spaces credentials list --json
balanceframe audit query --actor-id usr_member --json
```

Grant changes can be explicitly revoked with the same resource scope:

```sh
balanceframe spaces grants revoke \
  --membership-id mem_123 \
  --capability transaction:view \
  --resource-kind account \
  --resource-id acc_123 \
  --json
```

Bulk review approval also requires one exact displayed payload hash per review ID. Supply
the server-returned hash values unchanged; the CLI does not fetch or calculate them:

```sh
balanceframe reviews show rev_123 --json
balanceframe reviews show rev_456 --json
balanceframe reviews approve-bulk rev_123 rev_456 \
  --payload-hashes '{"rev_123":"DISPLAYED_HASH_123","rev_456":"DISPLAYED_HASH_456"}' \
  --json
```

Proposal approval requires the exact displayed payload hash:

```sh
balanceframe proposals show prop_123 --json
balanceframe proposals approve prop_123 --payload-hash DISPLAYED_HASH --json
```

`--actor-id` is only an audit filter; it never selects the caller. Server responses are
validated as versioned API envelopes, and server errors remain errors.

## Selected-space lifecycle controls

The existing lifecycle commands use the same authenticated Source transport:

```sh
balanceframe export --json
balanceframe disconnect --json
balanceframe remove-connection --json
balanceframe delete-data --scope notification --json
```

These require the relevant selected-space control grant and a current human session
with fresh reauthentication; delegated API keys are not sufficient. Export creates a
private server-side artifact for the selected budget and records its verified provenance.
Deletion requires a verified export for the same scope. Disconnect preserves the saved
selection; remove-connection removes only the selected connection configuration.
Neither operation disconnects an unrelated budget's active connection. Data deletion
does not erase retained historical identity, approval, or governance audit attribution.

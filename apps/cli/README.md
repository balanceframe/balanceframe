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

Native rules target an exact, case-sensitive Actual payee ID, never a display name:

```sh
balanceframe rules create --name "Market groceries" \
  --payee-id PAYEE_ID --category-id CATEGORY_ID --json
```

This creates a governed proposal; review its complete simulation and global future
scope before independently approving the displayed hash and executing it.

### Local merchant evidence

```sh
balanceframe merchant analyze --limit 200 --json
balanceframe merchant evidence --transaction-id TRANSACTION_ID --json
balanceframe merchant policy get --json
balanceframe merchant calendar --account-id ACCOUNT_ID --year 2026 --json
balanceframe merchant confirm --id DECISION_ID --kind alias \
  --evidence-key EVIDENCE_KEY --evidence-revision CURRENT_REVISION \
  --expected-version 0 --private --transaction-id TRANSACTION_ID \
  --source-field importedPayee --target-payee-id PAYEE_ID --account-id ACCOUNT_ID --json
balanceframe merchant reject --id DECISION_ID --kind pattern \
  --pattern-id PATTERN_ID --evidence-key EVIDENCE_KEY \
  --evidence-revision CURRENT_REVISION --expected-version VERSION --shared --json
balanceframe merchant policy set --expected-version VERSION --policy 'FULL_POLICY_JSON' --json
balanceframe merchant export --json
balanceframe merchant delete --json
```

Evidence reads support `--cursor` and `--facts-hash`; these are optimistic selection
tokens, not authority. Confirmation/rejection requires exactly one of `--private` or
`--shared`, current evidence and decision versions, and a freshly reauthenticated human
session. For an explicitly global alias match, use `--account-id null`; the server still
requires global authority. Decisions never write Actual or consent to external research.
Policy replacement includes every account calendar override; unauthorized full policy
reads must not be used to assemble a partial overwrite. Calendar lookup reads only
stored selections, with unsupported coverage reported as unknown. Export, deletion and
policy writes have independent grants and fresh human checks. Machine JSON preserves
canonical Money decimal strings and source currencies without display conversion.

### Explicit public-business research

Local analysis, source normalization, native rules and review never initiate external
research. Enter a **standalone public business name manually**; do not copy or extract
bank/import/payee/notes text. The declaration expresses your intent, not automatic
identity verification or a guarantee that text contains no private information.

```sh
balanceframe merchant research policy --json
balanceframe merchant space-policy get --json
balanceframe merchant research preview --evidence-key EVIDENCE_KEY \
  --evidence-revision CURRENT_REVISION --merchant 'Public Business Name' \
  --public-business true --json
# Review the exact merchant text, provider, fields, expiry, disclosure and cost first.
balanceframe merchant research send --evidence-key EVIDENCE_KEY \
  --evidence-revision CURRENT_REVISION --merchant 'Public Business Name' \
  --public-business true --preview-token DISPLAYED_TOKEN --consent true \
  --idempotency-key UNIQUE_OPERATION_ID --json
balanceframe merchant research cache --evidence-key EVIDENCE_KEY \
  --evidence-revision CURRENT_REVISION --merchant 'Public Business Name' \
  --public-business true --json
balanceframe merchant space-policy set --expected-version VERSION \
  --policy 'COMPLETE_SPACE_POLICY_JSON' --json
```

Omit `--locale` to send no locale; only explicit `US`, `CA` or `GB` is supported.
Preview is not consent and sends nothing to the provider. A separate send must match
the exact preview query, locale and current evidence revision, carry the unexpired
preview token, and explicitly declare consent. No retry or automatic send follows a
preview, denial, pending result or uncertain failure. Uncertain billing can retain the
maximum charge reservation even when no enrichment is returned.

Costs remain decimal-string **atoms**, with 1,000,000 atoms per billing minor unit;
they are not floating-point money and provider billing currency is independent of
the source budget currency. Public search sends approved business text and optional
coarse locale; the provider sees the server IP and may retain logs, with exact
retention unknown. Sent requests cannot be recalled. App limits do not cap other
credential usage or delete provider logs.

Effective policy intersects independently versioned installation, space and budget
layers; a child cannot override an ancestor denial. Space replacement uses its own
optimistic version and complete value, forbids account calendars, and requires an
existing freshly reauthenticated human session. Installation policy and credentials
are server-owned, never CLI flags. Budget calendar replacement remains unchanged.
Delegated API-key research still requires current server-enforced research/source
rights and caps; local Actual credentials and actor environment labels confer none.

Cache reads are explicit and freshly authorized. Results expose historical
retrieval/expiry/provider/fields-sent provenance and uncalibrated confidence. Source
titles, snippets and URLs are untrusted semantic observations, never financial
category, identity, approval or execution proof. The CLI validates public response
DTOs strictly and does not fetch source pages. Missing configuration, local-only
policy and provider outage leave ordinary local review usable.

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

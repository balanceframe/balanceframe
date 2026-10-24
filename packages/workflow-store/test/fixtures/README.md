# Released workflow-store fixture

`v0.4.0-workflow.sql` comes from commit
`7b26e44c6df9de3d5beedb59d888e43f19381860`, with schema versions **1–11**.
Its SHA-256 is
`1bb309c852dafd804f4f268fceccf6b256165904d3aa42131996b067f750adcb`.
It contains a legacy session claim and revision saved through that release's
public API, four legacy grants, liquidity policy/session audit history, and a
canonical synthetic suggestion. The trusted validation callback is a fixture
stub; no native financial evaluation or external write is performed. That
release has no `liquidity_claim_metadata` table. Its metadata was added to the
already-released migration 10 in commit `55b304c`, first shipped in v0.5.0;
an existing v0.4.0 database consequently skips that definition.

`v0.8.0-workflow.sql` is a frozen, entirely synthetic persisted store produced
by **v0.8.0**, commit
`59743bc1b5aa35310f98a2d148eda12a49231c88`, with schema versions **1–27**.
Its SHA-256 is
`9341722ffcd5ff2faa324238915418c8e494d5f0aae017aa89237b2d3b5913cd`.

The generator extracts the released workflow-store source, released protocol
source/validators, and canonical `protocol/fixtures/representative.json` directly
from that Git object. Installed TypeScript transpiles the released source;
installed `better-sqlite3` and Zod run it. The released constructor creates the
schema and its public APIs populate the synthetic data. No schema SQL is copied
from the current migration array. The old store is closed and reopened before
Python's standard-library SQLite exporter creates the SQL dump.

The v0.8.0 fixture contains a synthetic owner and shared space, budget binding, scoped
grants, a former member, a genuine expired proposal approval, a simulated
completed idempotency record, a suggestion and Review item using canonical
transaction `tx_000`/category `cat_2`, a saved view, and the resulting audit
history. The old APIs revoke the former membership and expire the approval
before export. The completed record simulates a prior execution; the generator
never connects to Actual or performs a financial mutation.

All UUIDs and timestamps are fixed. Actors, session IDs, budget IDs, and the
`example.test` email are fictional. No live database, configuration, credentials,
or network service is read. Generation was verified twice with identical output
using Node 24.11.1, TypeScript 5.9.3, better-sqlite3 13.0.3 (SQLite 3.53.4), Zod
3.25.76, and Python 3.15.0. These are existing dependencies; no package changes
are required.

From an installed checkout with both release Git objects present, regenerate with:

```sh
node packages/workflow-store/test/fixtures/generate-released-workflow.mjs v0.4.0
node packages/workflow-store/test/fixtures/generate-released-workflow.mjs v0.8.0
sha256sum packages/workflow-store/test/fixtures/v*-workflow.sql
```

Ordinary tests use the frozen SQL and need neither Git history, Python, nor
fixture regeneration:

```sh
pnpm --filter @balanceframe/workflow-store exec vitest run test/released-store-upgrade.test.ts
```

The v0.8.0 regression imports its dump into a disposable on-disk database, checks
its released schema and populated sentinels, then opens it with the current store.
It checks every pre-existing table's rows and migration timestamps, new schema
versions/tables, SQLite integrity and foreign keys, public API reads, expired
approval inactivity, revoked-member denial, completed-execution replay rejection,
and unchanged results after another close/reopen. Foreign keys are disabled
only during SQL import because dump table order can precede referenced parents;
they are re-enabled before validation.

Negative control: temporarily replacing migration 28 with a no-op made this
test fail in migration 29 with `no such table: transaction_evidence_documents`.
The temporary test-only replacement was removed before passing verification.

This covers workflow SQLite upgrade compatibility. It does not verify Better
Auth migrations, configuration/secret continuity, container volume permissions,
Actual synchronization, browser behavior, downgrade compatibility, or recovery
of any particular deployed database. Existing tests built from slices of the
current migration array remain useful for individual historical migrations;
they do not replace this released-source fixture.

The v0.4.0 regressions cover both its original schema 11 and the interrupted
schema-12 state obtained by committing the current migration 12 onto that
released fixture. They preserve the original claim JSON, revision and grant
facts, require empty metadata and no new space/membership authority, compare the
repaired table/index definitions with a fresh store, and reopen successfully.
A deliberately malformed claim column verifies rollback of the prerequisite
and migration marker when migration 13 subsequently fails, followed by a
successful retry from schema 12 once that temporary test defect is corrected.

Both released-store paths, including interrupted schema 12, compare all user
tables with a fresh current store after upgrade and reopen. The comparison uses
SQLite metadata for table names/types, rowid/strict flags, all columns (including
hidden/generated columns, defaults and primary keys), index columns/order/
collation/uniqueness, and grouped composite foreign keys/actions. Named index SQL
also captures expression and partial-index predicates. Generated index names and
foreign-key IDs are normalized; tables, indexes and constraints are sorted.
The existing exact metadata table/index SQL comparison remains in place.

This is structural coverage of those measured fields, not universal schema or
behavior equivalence: CHECK bodies, generated-column expressions, table-level
conflict clauses, foreign-key deferral, views/triggers, and data-transform
semantics still require review and targeted behavior tests. A separate populated
metadata case verifies that migration 13 preserves existing metadata and its
index while retaining scope conversion and one-time revision advancement.

Parity negative control: temporarily adding an unused table to already-released
migration 10 allowed store startup, but all three released-store parity checks
failed on the missing table. The temporary production edit was restored before
passing verification. These tests run in the existing workflow-store suite;
future supported releases should add genuine frozen release-produced fixtures
rather than reconstructing their historical schemas from current migrations.

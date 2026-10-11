import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createOwnedScenarioRoot, discardOwnedScenarioRoot, startScenarioShell, stopScenarioProcesses } from '../../packages/scenario-kit/dist/scenario-kit/src/process-runtime.js';
import { materializeScenario } from '../../packages/scenario-kit/dist/scenario-kit/src/catalog.js';
import { builtWebEntry, initializeScenarioShell } from '../../packages/scenario-kit/dist/scenario-kit/src/loader.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(ROOT, 'packages/scenario-kit/package.json'));
const { SqliteWorkflowStore } = require('@balanceframe/workflow-store');
const Database = createRequire(require.resolve('@balanceframe/workflow-store'))('better-sqlite3');
const NOW = '2098-01-01T12:00:00.000Z';
const WRITES = 50_000;
// Isolated grant-write regression ceiling, not the native analysis memory gate.
const MAX_INCREMENTAL_RSS_BYTES = 512 * 1024 * 1024;

test('exact native fixture grants retain bounded allocation, audits and fresh identity checks',
  { timeout: 300_000 }, async () => {
    const root = createOwnedScenarioRoot();
    let processes;
    let store;
    let db;
    let retainRoot = false;
    try {
      const scenario = materializeScenario('merchant-local-sparse', new Date('2026-10-04T12:00:00.000Z'));
      processes = await startScenarioShell({ root, webEntry: builtWebEntry(), scenarioId: scenario.id });
      const loaded = await initializeScenarioShell(processes, scenario);
      store = new SqliteWorkflowStore(processes.workflowDbPath);
      db = new Database(processes.workflowDbPath, { readonly: true });
      const auditCount = db.prepare('SELECT count(*) AS count FROM space_governance_audit');
      const auditsBefore = auditCount.get().count;
      const owner = loaded.initialized.personas.owner;
      const nativeIds = scenario.ledger.transactions.map((row) => loaded.seeded.transactionIds[row.id]);
      assert(nativeIds.every((id) => typeof id === 'string' && id.length > 0));
      const baselineRss = process.memoryUsage().rss;
      let lastInput;
      for (let index = 0; index < WRITES; index += 1) {
        lastInput = {
          spaceId: loaded.initialized.spaceId, actorId: owner.actorId,
          membershipId: owner.membershipId, budgetId: loaded.seeded.budgetId,
          resourceKind: 'transaction', resourceId: nativeIds[Math.floor(index / 2) % nativeIds.length],
          capability: index % 2 === 0 ? 'transaction.view' : 'source',
          granted: true, restrictions: {}, now: NOW,
        };
        const grant = store.governance.provisionResourceGrant(lastInput);
        assert.deepEqual({
          spaceId: grant?.spaceId, actorId: grant?.actorId, membershipId: grant?.membershipId,
          budgetId: grant?.budgetId, resourceKind: grant?.resourceKind, resourceId: grant?.resourceId,
          capability: grant?.capability, granted: grant?.granted, restrictions: grant?.restrictions,
          now: grant?.updatedAt, revokedAt: grant?.revokedAt,
        }, { ...lastInput, revokedAt: null });
        if ((index + 1) % 5_000 === 0) {
          const incrementalRss = process.memoryUsage().rss - baselineRss;
          assert(incrementalRss <= MAX_INCREMENTAL_RSS_BYTES,
            `Isolated exact-grant writes exceeded operational RSS ceiling after ${index + 1} writes: ${incrementalRss}`);
        }
      }
      assert.equal(auditCount.get().count, auditsBefore + WRITES);
      await store.upsertActorMembership(owner.actorId, 'inactive', ['*'], '*');
      assert.throws(() => store.governance.provisionResourceGrant(lastInput), /current membership period/);
      assert.equal(auditCount.get().count, auditsBefore + WRITES);
    } catch (error) {
      retainRoot = error instanceof Error && 'ownedCleanupUnproven' in error && error.ownedCleanupUnproven === true;
      throw error;
    } finally {
      db?.close();
      store?.close();
      if (processes) await stopScenarioProcesses(processes, { retainRoot });
      else if (!retainRoot) discardOwnedScenarioRoot(root);
    }
  });

import { afterEach, describe, expect, it } from 'vitest';
import {
  addTransactions,
  downloadBudget,
  getAccounts,
  getTransactions,
  init,
  shutdown,
  sync,
} from '@actual-app/api';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeScenario, type MaterializedScenario } from '../src/catalog.js';
import { seedActualBudget, type SeededActualBudget } from '../src/actual-seed.js';
import {
  createOwnedScenarioRoot,
  discardOwnedScenarioRoot,
  startScenarioActual,
  startScenarioShell,
  stopScenarioProcesses,
  type ScenarioProcesses,
} from '../src/process-runtime.js';
import { applyScenarioEvent } from '../src/events.js';

interface ActualRow {
  readonly id?: string;
  readonly amount?: number;
  readonly category?: string | null;
  readonly imported_id?: string | null;
  readonly importedId?: string | null;
}


interface TestWorkspace {
  readonly root: string;
  readonly serverUrl: string;
  readonly secretKey: string;
  readonly scenario: MaterializedScenario;
  readonly seeded: SeededActualBudget;
}

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WEB_ENTRY = resolve(REPOSITORY_ROOT, 'apps/web/.output/server/index.mjs');
const TEST_TIMEOUT = 120_000;
const activeProcesses = new Set<ScenarioProcesses>();
let publicOriginPort = 39_100;

async function withActualClient<T>(
  workspace: Pick<TestWorkspace, 'serverUrl' | 'secretKey' | 'root'>,
  callback: () => Promise<T>,
): Promise<T> {
  const dataDir = mkdtempSync(join(workspace.root, 'event-client-'));
  await init({
    serverURL: workspace.serverUrl,
    password: workspace.secretKey,
    dataDir,
  });
  try {
    return await callback();
  } finally {
    await shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function createWorkspace(scenarioId: MaterializedScenario['id']): Promise<TestWorkspace> {
  const root = createOwnedScenarioRoot();
  const publicOrigin = `http://127.0.0.1:${publicOriginPort++}`;
  let handle: ScenarioProcesses;
  try {
    handle = await startScenarioShell({ root, publicOrigin, webEntry: WEB_ENTRY });
  } catch (error) {
    await discardOwnedScenarioRoot(root);
    throw error;
  }
  activeProcesses.add(handle);
  await startScenarioActual(handle);
  const scenario = materializeScenario(scenarioId, new Date('2026-09-06T12:00:00.000Z'));
  const seeded = await seedActualBudget({
    serverUrl: handle.actualUrl,
    secretKey: handle.actualSecretKey,
    clientDir: handle.seedClientDir,
    budgetName: `Scenario events ${scenarioId}`,
    ledger: scenario.ledger,
  });
  return {
    root,
    serverUrl: handle.actualUrl,
    secretKey: handle.actualSecretKey,
    scenario,
    seeded,
  };
}

async function readRows(workspace: TestWorkspace): Promise<ActualRow[]> {
  return withActualClient(workspace, async () => {
    await downloadBudget(workspace.seeded.groupId);
    const accounts = await getAccounts();
    const rows: ActualRow[] = [];
    for (const account of accounts) {
      rows.push(
        ...((await getTransactions(account.id, '1900-01-01', '2999-12-31')) as unknown as ActualRow[]),
      );
    }
    return rows;
  });
}

async function seedMatchingManualTransaction(workspace: TestWorkspace): Promise<void> {
  const event = workspace.scenario.events['import-match'];
  if (!event || event.kind !== 'import-match') throw new Error('Expected import-match recipe');
  await withActualClient(workspace, async () => {
    await downloadBudget(workspace.seeded.groupId);
    const accountId = workspace.seeded.accountIds[event.candidate.accountId];
    const categoryId = workspace.seeded.categoryIds['cat-groceries'];
    const payeeId = workspace.seeded.payeeIds['pay-market'];
    await addTransactions(accountId, [
      {
        date: event.candidate.date,
        amount: Number(BigInt(event.candidate.amount.minorUnits)),
        payee: payeeId,
        category: categoryId,
        notes: 'fixture completion debit',
        cleared: true,
      },
    ]);
    await sync();
  });
}

afterEach(async () => {
  for (const handle of [...activeProcesses].reverse()) {
    activeProcesses.delete(handle);
    await stopScenarioProcesses(handle);
  }
});

describe('scenario Actual events', () => {
  it(
    'updates the uncategorized row category and preserves its amount/economic total',
    { timeout: TEST_TIMEOUT },
    async () => {
      const workspace = await createWorkspace('uncategorized-debit');
      const event = workspace.scenario.events['categorize-uncategorized'];
      if (!event || event.kind !== 'categorize-uncategorized') throw new Error('Expected category recipe');

      const before = await readRows(workspace);
      const sourceId = workspace.seeded.transactionIds[event.transactionId];
      const source = before.find((row) => row.id === sourceId);
      expect(source).toMatchObject({ amount: -1000 });
      expect(source?.category ?? null).toBeNull();
      const beforeTotal = before.reduce((sum, row) => sum + (row.amount ?? 0), 0);

      const result = await applyScenarioEvent({
        scenario: workspace.scenario,
        seeded: workspace.seeded,
        root: workspace.root,
        actualServerUrl: workspace.serverUrl,
        actualSecretKey: workspace.secretKey,
        eventId: 'categorize-uncategorized',
      });

      const after = await readRows(workspace);
      const updated = after.find((row) => row.id === sourceId);
      expect(updated).toMatchObject({
        id: sourceId,
        amount: -1000,
        category: workspace.seeded.categoryIds[event.categoryId],
      });
      expect(after).toHaveLength(before.length);
      expect(after.reduce((sum, row) => sum + (row.amount ?? 0), 0)).toBe(beforeTotal);
      expect(result).toMatchObject({
        eventId: 'categorize-uncategorized',
        kind: 'categorize-uncategorized',
        transactionId: sourceId,
        categoryId: workspace.seeded.categoryIds[event.categoryId],
        amount: -1000,
      });
    },
  );

  it(
    'matches an import identity without adding a second economic debit on repeat',
    { timeout: TEST_TIMEOUT },
    async () => {
      const workspace = await createWorkspace('import-after-completion');
      await seedMatchingManualTransaction(workspace);
      const event = workspace.scenario.events['import-match'];
      if (!event || event.kind !== 'import-match') throw new Error('Expected import recipe');
      const before = await readRows(workspace);
      const beforeTotal = before.reduce((sum, row) => sum + (row.amount ?? 0), 0);

      const first = await applyScenarioEvent({
        scenario: workspace.scenario,
        seeded: workspace.seeded,
        root: workspace.root,
        actualServerUrl: workspace.serverUrl,
        actualSecretKey: workspace.secretKey,
        eventId: 'import-match',
      });
      const second = await applyScenarioEvent({
        scenario: workspace.scenario,
        seeded: workspace.seeded,
        root: workspace.root,
        actualServerUrl: workspace.serverUrl,
        actualSecretKey: workspace.secretKey,
        eventId: 'import-match',
      });

      const after = await readRows(workspace);
      const matches = after.filter(
        (row) => (row.imported_id ?? row.importedId) === event.candidate.importedId,
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({ amount: -2000, imported_id: event.candidate.importedId });
      expect(after).toHaveLength(before.length);
      expect(after.reduce((sum, row) => sum + (row.amount ?? 0), 0)).toBe(beforeTotal);
      expect(first).toMatchObject({
        eventId: 'import-match',
        kind: 'import-match',
        importedIds: [event.candidate.importedId],
        amounts: [-2000],
      });
      expect(second).toEqual(first);
    },
  );

  it(
    'imports two ambiguous candidates once each and never duplicates their economic debit',
    { timeout: TEST_TIMEOUT },
    async () => {
      const workspace = await createWorkspace('ambiguous-completion');
      const event = workspace.scenario.events['import-ambiguous'];
      if (!event || event.kind !== 'import-ambiguous') throw new Error('Expected ambiguous recipe');
      const before = await readRows(workspace);

      await applyScenarioEvent({
        scenario: workspace.scenario,
        seeded: workspace.seeded,
        root: workspace.root,
        actualServerUrl: workspace.serverUrl,
        actualSecretKey: workspace.secretKey,
        eventId: 'import-ambiguous',
      });
      await applyScenarioEvent({
        scenario: workspace.scenario,
        seeded: workspace.seeded,
        root: workspace.root,
        actualServerUrl: workspace.serverUrl,
        actualSecretKey: workspace.secretKey,
        eventId: 'import-ambiguous',
      });

      const after = await readRows(workspace);
      const importedIds = event.candidates.map((candidate) => candidate.importedId);
      const matches = after.filter((row) => importedIds.includes(row.imported_id ?? row.importedId ?? ''));
      expect(matches).toHaveLength(2);
      expect(matches.map((row) => row.amount)).toEqual(expect.arrayContaining([-2000, -2000]));
      expect(after).toHaveLength(before.length + 2);
      expect(matches.reduce((sum, row) => sum + (row.amount ?? 0), 0)).toBe(-4000);
    },
  );

  it(
    'rejects an event not listed by the scenario before making any Actual write',
    { timeout: TEST_TIMEOUT },
    async () => {
      const workspace = await createWorkspace('funded-purchase');
      const before = await readRows(workspace);

      await expect(
        applyScenarioEvent({
          scenario: workspace.scenario,
          seeded: workspace.seeded,
          root: workspace.root,
          actualServerUrl: workspace.serverUrl,
          actualSecretKey: workspace.secretKey,
          eventId: 'import-match' as never,
        }),
      ).rejects.toThrow(/event|scenario|supported|listed/i);

      const after = await readRows(workspace);
      expect(after).toEqual(before);
    },
  );
});

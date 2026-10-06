import { afterEach, describe, expect, it } from 'vitest';
import {
  addTransactions,
  createRule,
  downloadBudget,
  getAccounts,
  getPayees,
  getRules,
  getTransactions,
  init,
  shutdown,
  sync,
} from '@actual-app/api';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { APIRuleEntity } from '@actual-app/api/models';
import { z } from 'zod';
import { materializeScenario, type MaterializedScenario, type ScenarioEventId } from '../src/catalog.js';
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
  readonly account?: string;
  readonly payee?: string | null;
  readonly notes?: string;
  readonly cleared?: boolean;
  readonly reconciled?: boolean;
  readonly imported_payee?: string | null;
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

async function createWorkspace(scenarioId: string): Promise<TestWorkspace> {
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

async function seedMatchingManualTransaction(
  workspace: TestWorkspace,
  eventId: 'import-match' | 'import-ambiguous' = 'import-match',
): Promise<void> {
  const recipe = workspace.scenario.events[eventId];
  const candidate = recipe?.kind === 'import-match'
    ? recipe.candidate
    : recipe?.kind === 'import-ambiguous'
      ? recipe.candidates[0]
      : undefined;
  if (!candidate) throw new Error(`Expected ${eventId} recipe`);
  await withActualClient(workspace, async () => {
    await downloadBudget(workspace.seeded.groupId);
    const accountId = workspace.seeded.accountIds[candidate.accountId];
    const categoryId = workspace.seeded.categoryIds['cat-groceries'];
    const payeeId = workspace.seeded.payeeIds['pay-market'];
    await addTransactions(accountId, [
      {
        date: candidate.date,
        amount: Number(BigInt(candidate.amount.minorUnits)),
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
      await seedMatchingManualTransaction(workspace, 'import-ambiguous');
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
    'lets Actual alone apply a native rule to a future import on the other account, once',
    { timeout: TEST_TIMEOUT },
    async () => {
      const workspace = await createWorkspace('merchant-native-rule-lifecycle');
      const event = workspace.scenario.events['import-match'];
      if (!event || event.kind !== 'import-match') throw new Error('Expected native future import recipe');
      expect(event.candidate.accountId).toBe('acct-savings');
      expect(workspace.scenario.ledger.transactions
        .filter((row) => row.id.startsWith('categorization-history-0-'))
        .map((row) => row.accountId)).toEqual(['acct-checking', 'acct-checking', 'acct-checking']);
      const nativePayeeId = workspace.seeded.payeeIds['pay-market'];
      const nativeCategoryId = workspace.seeded.categoryIds['cat-groceries'];
      if (!nativePayeeId || !nativeCategoryId) throw new Error('Native rule fixture references are missing');
      // The governed proposal journey supplies this native write in acceptance.
      // At this boundary use only the verified public SDK: no BF import adapter
      // or matcher can make this assertion pass.
      const ruleInput: Omit<APIRuleEntity, 'id'> = {
        stage: 'post',
        conditionsOp: 'and',
        conditions: [
          { field: 'imported_payee', op: 'is', value: event.candidate.payeeName, type: 'string' },
        ],
        actions: [
          { field: 'payee', op: 'set', value: nativePayeeId, type: 'id' },
          { field: 'category', op: 'set', value: nativeCategoryId, type: 'id' },
        ],
      };
      const nativeRule = await withActualClient(workspace, async () => {
        await downloadBudget(workspace.seeded.groupId);
        const created = await createRule(ruleInput);
        expect(await getRules()).toContainEqual(expect.objectContaining({ id: created.id, ...ruleInput }));
        await sync();
        return created;
      });
      const before = await readRows(workspace);
      const beforeTotal = before.reduce((sum, row) => sum + (row.amount ?? 0), 0);
      const options = {
        scenario: workspace.scenario,
        seeded: workspace.seeded,
        root: workspace.root,
        actualServerUrl: workspace.serverUrl,
        actualSecretKey: workspace.secretKey,
        eventId: 'import-match' as const,
      };
      const first = await applyScenarioEvent(options);
      const second = await applyScenarioEvent(options);
      const after = await readRows(workspace);
      const imported = after.filter((row) => row.imported_id === event.candidate.importedId);
      const amount = Number(BigInt(event.candidate.amount.minorUnits));
      expect(imported).toHaveLength(1);
      expect(imported[0]).toMatchObject({
        id: expect.any(String),
        account: workspace.seeded.accountIds['acct-savings'],
        amount,
        imported_id: event.candidate.importedId,
        imported_payee: event.candidate.payeeName,
        payee: nativePayeeId,
        category: nativeCategoryId,
        cleared: true,
      });
      expect(after).toHaveLength(before.length + 1);
      expect(after.reduce((sum, row) => sum + (row.amount ?? 0), 0)).toBe(beforeTotal + amount);
      expect(after.filter((row) => row.imported_id !== event.candidate.importedId)).toEqual(before);
      expect(first).toMatchObject({
        importedIds: [event.candidate.importedId],
        transactionIds: [imported[0]!.id],
        amounts: [amount],
      });
      expect(second).toEqual(first);
      await withActualClient(workspace, async () => {
        await downloadBudget(workspace.seeded.groupId);
        expect((await getRules()).filter((rule) => rule.id === nativeRule.id)).toEqual([
          expect.objectContaining({ id: nativeRule.id, ...ruleInput }),
        ]);
      });
    },
  );

  it(
    'changes real native merchant source fields without changing money, references, or row identity',
    { timeout: TEST_TIMEOUT },
    async () => {
      const workspace = await createWorkspace('merchant-native-rule-lifecycle');
      const recipe = z.object({
        kind: z.literal('merchant-source-change'),
        payeeId: z.literal('pay-market'),
        transactionId: z.literal('synthetic-holdout-000-02'),
        payeeName: z.string().min(1),
        importedPayee: z.string().min(1),
        notes: z.string().min(1),
      }).strict().parse(workspace.scenario.events['merchant-source-change']);
      const nativePayeeId = workspace.seeded.payeeIds[recipe.payeeId];
      const nativeTransactionId = workspace.seeded.transactionIds[recipe.transactionId];
      const beforeRows = await readRows(workspace);
      const beforeSource = beforeRows.find((row) => row.id === nativeTransactionId);
      if (!beforeSource || !nativePayeeId) throw new Error('Native source fixture is missing');
      const beforePayees = await withActualClient(workspace, async () => {
        await downloadBudget(workspace.seeded.groupId);
        return getPayees();
      });
      const beforePayee = beforePayees.find((payee) => payee.id === nativePayeeId);
      if (!beforePayee) throw new Error('Native source payee is missing');
      expect(beforePayee.name).not.toBe(recipe.payeeName);
      expect(beforeSource.imported_payee).not.toBe(recipe.importedPayee);
      expect(beforeSource.notes).not.toBe(recipe.notes);
      const options = {
        scenario: workspace.scenario,
        seeded: workspace.seeded,
        root: workspace.root,
        actualServerUrl: workspace.serverUrl,
        actualSecretKey: workspace.secretKey,
        // The finite catalog union is extended by the GREEN implementation.
        eventId: 'merchant-source-change' as ScenarioEventId,
      };
      await applyScenarioEvent(options);
      const afterRows = await readRows(workspace);
      expect(afterRows).toHaveLength(beforeRows.length);
      expect(afterRows.find((row) => row.id === nativeTransactionId)).toEqual({
        ...beforeSource,
        imported_payee: recipe.importedPayee,
        notes: recipe.notes,
      });
      expect(afterRows.filter((row) => row.id !== nativeTransactionId))
        .toEqual(beforeRows.filter((row) => row.id !== nativeTransactionId));
      const afterPayees = await withActualClient(workspace, async () => {
        await downloadBudget(workspace.seeded.groupId);
        return getPayees();
      });
      expect(afterPayees.find((payee) => payee.id === nativePayeeId)).toEqual({
        ...beforePayee, name: recipe.payeeName,
      });
      expect(afterPayees.filter((payee) => payee.id !== nativePayeeId))
        .toEqual(beforePayees.filter((payee) => payee.id !== nativePayeeId));
      await applyScenarioEvent(options);
      expect(await readRows(workspace)).toEqual(afterRows);
    },
  );

  it.each(['import-match', 'merchant-source-change'])(
    'rejects unlisted %s before making any Actual write',
    { timeout: TEST_TIMEOUT },
    async (eventId) => {
      const workspace = await createWorkspace('funded-purchase');
      const before = await readRows(workspace);

      await expect(
        applyScenarioEvent({
          scenario: workspace.scenario,
          seeded: workspace.seeded,
          root: workspace.root,
          actualServerUrl: workspace.serverUrl,
          actualSecretKey: workspace.secretKey,
          eventId: eventId as ScenarioEventId,
        }),
      ).rejects.toThrow(/event|scenario|supported|listed/i);

      const after = await readRows(workspace);
      expect(after).toEqual(before);
    },
  );
});

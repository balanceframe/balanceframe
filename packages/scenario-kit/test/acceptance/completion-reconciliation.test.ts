import { downloadBudget, getAccounts, getTransactions, init, shutdown } from '@actual-app/api';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { LoadedScenario } from '../../src/loader.js';
import { applyScenarioEvent } from '../../src/events.js';
import { scenarioRequest, withScenario } from './support.js';

const TEST_TIMEOUT = 180_000;

type Envelope<T> =
  | { status: 'ok'; result: T }
  | {
      status: 'error';
      result?: unknown;
      error?: { code?: string; message?: string } | null;
    };

type ApiResponse<T> = { status: number; body: Envelope<T> };

interface Money {
  minorUnits: string;
  currency: string;
}

interface CompletionDebit {
  accountId: string;
  amount: number;
  date: string;
  payeeName: string | null;
  notes: string | null;
  categoryCharges: { categoryId: string; amount: Money }[];
  splits: { categoryId: string; amount: number }[];
}

interface Completion {
  id: string;
  version: number;
  phase: string;
  outcome: string | null;
  expiresAt: string;
  cooldownUntil: string | null;
  payloadHash: string | null;
  requiredApprovals: number;
  approvalCount: number;
  canApprove: boolean;
  canExecute: boolean;
  debit: CompletionDebit | null;
  manualTransactionId: string | null;
  importedTransactionId: string | null;
  reviewRequired: boolean;
}

interface SessionItem {
  id: string;
  categoryId: string;
  amount: Money;
  accountId: string | null;
  purchaseAt: string;
  requiredBy: string;
  quantity?: number;
  priority?: 'required' | 'planned' | 'optional';
  categoryAllocations?: { categoryId: string; amount: Money }[];
  priceProvenance: unknown | null;
  barcode?: string | null;
}

interface Session {
  id: string;
  version: number;
  accountId: string | null;
  expiresAt: string;
  items: SessionItem[];
  adjustments: unknown[];
  warningThresholds: unknown[];
}

interface ActualRow {
  id?: string;
  account?: string;
  amount?: number;
  date?: string;
  category?: string | null;
  imported_id?: string | null;
  importedId?: string | null;
  parent_id?: string | null;
  is_child?: boolean;
  is_parent?: boolean;
  reconciled?: boolean;
  subtransactions?: ActualRow[];
}

function resultOf<T>(response: ApiResponse<T>): T {
  expect(
    response.status,
    response.body.status === 'error' ? response.body.error?.code : undefined,
  ).toBe(200);
  expect(response.body.status).toBe('ok');
  if (response.body.status !== 'ok') throw new Error('Expected an OK API response');
  return response.body.result;
}

function errorOf<T>(response: ApiResponse<T>, status: number, code: string): void {
  expect(response.status).toBe(status);
  expect(response.body.status).toBe('error');
  if (response.body.status !== 'error') throw new Error('Expected an error API response');
  expect(response.body.error?.code).toBe(code);
}

function completionPath(
  sessionId: string,
  completionId: string,
  action?: 'approve' | 'execute' | 'reconcile',
) {
  const base = `/api/spend-sessions/${encodeURIComponent(sessionId)}/completions/${encodeURIComponent(completionId)}`;
  return action ? `${base}/${action}` : base;
}

function actionBody(completion: Completion): {
  payloadHash: string;
  expectedVersion: number;
  idempotencyKey: string;
} {
  if (!completion.payloadHash) throw new Error('Completion payload hash is unavailable');
  return {
    payloadHash: completion.payloadHash,
    expectedVersion: completion.version,
    idempotencyKey: randomUUID(),
  };
}

function allRows(rows: readonly ActualRow[]): ActualRow[] {
  return rows.flatMap((row) => [row, ...allRows(row.subtransactions ?? [])]);
}

function importedId(row: ActualRow): string | null {
  return row.imported_id ?? row.importedId ?? null;
}

async function withActual<T>(handle: LoadedScenario, callback: () => Promise<T>): Promise<T> {
  const dataDir = mkdtempSync(join(handle.processes.root, 'completion-actual-client-'));
  await init({
    serverURL: handle.processes.actualUrl,
    password: handle.processes.actualSecretKey,
    dataDir,
  });
  try {
    await downloadBudget(handle.seeded.groupId);
    return await callback();
  } finally {
    await shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function actualRows(handle: LoadedScenario): Promise<ActualRow[]> {
  return withActual(handle, async () => {
    const accounts = (await getAccounts()) as Array<{ id?: string }>;
    const rows: ActualRow[] = [];
    for (const account of accounts) {
      if (!account.id) continue;
      rows.push(
        ...((await getTransactions(
          account.id,
          '1900-01-01',
          '2999-12-31',
        )) as unknown as ActualRow[]),
      );
    }
    return rows;
  });
}

function actualTotal(rows: readonly ActualRow[]): number {
  return rows.reduce((total, row) => total + (row.amount ?? 0), 0);
}

function sessionUpdateBody(session: Session, items = session.items): Record<string, unknown> {
  return {
    accountId: session.accountId,
    expiresAt: session.expiresAt,
    items,
    adjustments: session.adjustments,
    warningThresholds: session.warningThresholds,
    expectedVersion: session.version,
  };
}

async function waitForCooldown(
  handle: LoadedScenario,
  sessionId: string,
  completionId: string,
  deadline: string,
): Promise<Completion> {
  const stopAt = Date.parse(deadline) + 15_000;
  let latest: Completion | undefined;
  while (Date.now() <= stopAt) {
    const response = await scenarioRequest<Envelope<Completion>>(
      handle,
      completionPath(sessionId, completionId),
    );
    latest = resultOf(response);
    if (Date.parse(deadline) <= Date.now() && latest.canApprove) return latest;
    // This is an integration test of the real one-minute wall-clock deadline; fake timers cannot advance the child web process.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 250);
    await promise;
  }
  throw new Error(
    `Completion did not become approvable at its observed cooldown deadline ${deadline}`,
  );
}

describe('completion and reconciliation scenarios', () => {
  it(
    'split-completion proposes, approves, executes exact Actual splits, consumes the terminal hold, and is idempotent',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withScenario('split-completion', async (handle) => {
        if (handle.initialized.entry.kind !== 'completion')
          throw new Error('Expected a completion entry');
        const sessionId = handle.initialized.sessions.cart;
        const completionId = handle.initialized.completions.purchase;
        if (!sessionId || !completionId)
          throw new Error('Completion fixture IDs were not initialized');

        const proposed = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId),
          ),
        );
        expect(proposed).toMatchObject({
          id: completionId,
          phase: 'proposed',
          outcome: null,
          requiredApprovals: 1,
          approvalCount: 0,
          debit: {
            accountId: handle.seeded.accountIds['acct-checking'],
            amount: -2600,
          },
        });
        if (!proposed.debit) throw new Error('Split completion debit is unavailable');
        const byCategory = (left: { categoryId: string }, right: { categoryId: string }) =>
          left.categoryId.localeCompare(right.categoryId);
        expect([...proposed.debit.categoryCharges].sort(byCategory)).toMatchObject(
          [
            {
              categoryId: handle.seeded.categoryIds['cat-groceries'],
              amount: { minorUnits: '1300', currency: 'USD' },
            },
            {
              categoryId: handle.seeded.categoryIds['cat-household'],
              amount: { minorUnits: '800', currency: 'USD' },
            },
            {
              categoryId: handle.seeded.categoryIds['cat-entertainment'],
              amount: { minorUnits: '500', currency: 'USD' },
            },
          ].sort(byCategory),
        );
        expect([...proposed.debit.splits].sort(byCategory)).toEqual(
          [
            { categoryId: handle.seeded.categoryIds['cat-groceries'], amount: -1300 },
            { categoryId: handle.seeded.categoryIds['cat-household'], amount: -800 },
            { categoryId: handle.seeded.categoryIds['cat-entertainment'], amount: -500 },
          ].sort(byCategory),
        );

        const approved = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId, 'approve'),
            { method: 'POST', body: actionBody(proposed) },
          ),
        );
        expect(approved).toMatchObject({
          id: completionId,
          phase: 'approved',
          approvalCount: 1,
          requiredApprovals: 1,
          canExecute: true,
          debit: proposed.debit,
        });

        const beforeExecution = await actualRows(handle);
        const beforeTotal = actualTotal(beforeExecution);
        const executed = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId, 'execute'),
            { method: 'POST', body: actionBody(approved) },
          ),
        );
        expect(executed).toMatchObject({
          id: completionId,
          phase: 'verified',
          outcome: null,
          reviewRequired: false,
          manualTransactionId: expect.any(String),
          importedTransactionId: null,
          debit: proposed.debit,
        });
        if (!executed.manualTransactionId)
          throw new Error('Verified completion omitted its Actual parent ID');

        const afterExecution = await actualRows(handle);
        const parent = allRows(afterExecution).find(
          (row) => row.id === executed.manualTransactionId,
        );
        expect(parent).toMatchObject({
          id: executed.manualTransactionId,
          account: handle.seeded.accountIds['acct-checking'],
          amount: -2600,
          date: proposed.debit.date,
          is_parent: true,
        });
        expect(parent?.category ?? null).toBeNull();
        expect(parent?.subtransactions).toHaveLength(3);
        expect(parent?.subtransactions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              account: handle.seeded.accountIds['acct-checking'],
              amount: -1300,
              category: handle.seeded.categoryIds['cat-groceries'],
              is_child: true,
              parent_id: executed.manualTransactionId,
            }),
            expect.objectContaining({
              account: handle.seeded.accountIds['acct-checking'],
              amount: -800,
              category: handle.seeded.categoryIds['cat-household'],
              is_child: true,
              parent_id: executed.manualTransactionId,
            }),
            expect.objectContaining({
              account: handle.seeded.accountIds['acct-checking'],
              amount: -500,
              category: handle.seeded.categoryIds['cat-entertainment'],
              is_child: true,
              parent_id: executed.manualTransactionId,
            }),
          ]),
        );
        expect(afterExecution).toHaveLength(beforeExecution.length + 1);
        expect(actualTotal(afterExecution)).toBe(beforeTotal - 2600);

        const claimsAfterExecution = resultOf(
          await scenarioRequest<Envelope<unknown[]>>(handle, '/api/liquidity/claims'),
        );
        expect(claimsAfterExecution).toEqual([]);

        const repeated = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId, 'execute'),
            { method: 'POST', body: actionBody(executed) },
          ),
        );
        expect(repeated).toMatchObject({
          id: completionId,
          phase: 'verified',
          manualTransactionId: executed.manualTransactionId,
          importedTransactionId: null,
        });
        const afterRepeat = await actualRows(handle);
        expect(afterRepeat).toHaveLength(afterExecution.length);
        expect(actualTotal(afterRepeat)).toBe(beforeTotal - 2600);
        expect(
          allRows(afterRepeat).filter((row) => row.id === executed.manualTransactionId),
        ).toHaveLength(1);
      });
    },
  );

  it(
    'cooldown-completion rejects early approval, observes its deadline, approves unchanged intent, and invalidates it after a cart edit',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withScenario('cooldown-completion', async (handle) => {
        const sessionId = handle.initialized.sessions.cart;
        const completionId = handle.initialized.completions.purchase;
        if (!sessionId || !completionId)
          throw new Error('Cooldown completion IDs were not initialized');

        const proposed = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId),
          ),
        );
        expect(proposed.phase).toBe('proposed');
        expect(proposed.cooldownUntil).toEqual(expect.any(String));
        expect(proposed.canApprove).toBe(false);
        if (!proposed.cooldownUntil)
          throw new Error('Cooldown proposal omitted its observed deadline');
        const deadline = proposed.cooldownUntil;

        const early = await scenarioRequest<Envelope<Completion>>(
          handle,
          completionPath(sessionId, completionId, 'approve'),
          { method: 'POST', body: actionBody(proposed) },
        );
        errorOf(early, 409, 'LIQUIDITY_REFRESH_REQUIRED');

        const ready = await waitForCooldown(handle, sessionId, completionId, deadline);
        expect(ready).toMatchObject({
          phase: 'proposed',
          cooldownUntil: deadline,
          canApprove: true,
        });
        const approved = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId, 'approve'),
            { method: 'POST', body: actionBody(ready) },
          ),
        );
        expect(approved).toMatchObject({
          phase: 'approved',
          cooldownUntil: deadline,
          approvalCount: 1,
          canExecute: true,
          debit: ready.debit,
        });

        const session = resultOf(
          await scenarioRequest<Envelope<Session>>(
            handle,
            `/api/spend-sessions/${encodeURIComponent(sessionId)}`,
          ),
        );
        const changedItems = session.items.map((item) =>
          item.id === 'optional-entertainment'
            ? { ...item, quantity: (item.quantity ?? 1) + 1 }
            : item,
        );
        const changed = resultOf(
          await scenarioRequest<Envelope<Session>>(
            handle,
            `/api/spend-sessions/${encodeURIComponent(sessionId)}`,
            { method: 'PUT', body: sessionUpdateBody(session, changedItems) },
          ),
        );
        expect(changed.version).toBe(session.version + 1);

        const invalidated = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId),
          ),
        );
        expect(invalidated).toMatchObject({
          id: completionId,
          phase: 'closed',
          outcome: 'superseded',
          approvalCount: 0,
          payloadHash: approved.payloadHash,
          debit: approved.debit,
        });
        const listed = resultOf(
          await scenarioRequest<Envelope<Completion[]>>(
            handle,
            `/api/spend-sessions/${encodeURIComponent(sessionId)}/completions`,
          ),
        );
        expect(listed).toEqual([
          expect.objectContaining({ id: completionId, phase: 'closed', outcome: 'superseded' }),
        ]);
      });
    },
  );

  it(
    'coapproval-completion gives a scoped peer read and approval while denying session edits/execution and restricted details',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withScenario('coapproval-completion', async (handle) => {
        const sessionId = handle.initialized.sessions.cart;
        const completionId = handle.initialized.completions.purchase;
        if (!sessionId || !completionId)
          throw new Error('Coapproval completion IDs were not initialized');

        const ownerSession = resultOf(
          await scenarioRequest<Envelope<Session>>(
            handle,
            `/api/spend-sessions/${encodeURIComponent(sessionId)}`,
          ),
        );
        const ownerProposal = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId),
          ),
        );
        expect(ownerProposal).toMatchObject({
          phase: 'proposed',
          approvalCount: 0,
          requiredApprovals: 2,
          debit: {
            accountId: handle.seeded.accountIds['acct-checking'],
            amount: -2600,
            categoryCharges: expect.arrayContaining([
              {
                categoryId: handle.seeded.categoryIds['cat-groceries'],
                amount: { minorUnits: '1300', currency: 'USD' },
              },
              {
                categoryId: handle.seeded.categoryIds['cat-household'],
                amount: { minorUnits: '800', currency: 'USD' },
              },
              {
                categoryId: handle.seeded.categoryIds['cat-entertainment'],
                amount: { minorUnits: '500', currency: 'USD' },
              },
            ]),
            splits: expect.arrayContaining([
              { categoryId: handle.seeded.categoryIds['cat-groceries'], amount: -1300 },
              { categoryId: handle.seeded.categoryIds['cat-household'], amount: -800 },
              { categoryId: handle.seeded.categoryIds['cat-entertainment'], amount: -500 },
            ]),
          },
        });
        expect(ownerProposal.debit?.categoryCharges).toHaveLength(3);
        expect(ownerProposal.debit?.splits).toHaveLength(3);

        const peerSession = await scenarioRequest<Envelope<Session>>(
          handle,
          `/api/spend-sessions/${encodeURIComponent(sessionId)}`,
          { personaId: 'coapprover' },
        );
        errorOf(peerSession, 403, 'LIQUIDITY_DENIED');
        const peerView = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId),
            { personaId: 'coapprover' },
          ),
        );
        expect(peerView).toMatchObject({
          id: completionId,
          phase: 'proposed',
          approvalCount: 0,
          requiredApprovals: 2,
          debit: ownerProposal.debit,
        });

        const peerEdit = await scenarioRequest<Envelope<Session>>(
          handle,
          `/api/spend-sessions/${encodeURIComponent(sessionId)}`,
          {
            method: 'PUT',
            personaId: 'coapprover',
            body: sessionUpdateBody(ownerSession, ownerSession.items),
          },
        );
        errorOf(peerEdit, 403, 'LIQUIDITY_DENIED');

        const peerApproved = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId, 'approve'),
            { method: 'POST', personaId: 'coapprover', body: actionBody(peerView) },
          ),
        );
        expect(peerApproved).toMatchObject({
          id: completionId,
          phase: 'proposed',
          approvalCount: 1,
          requiredApprovals: 2,
          canExecute: false,
        });

        const ownerAfterPeer = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId),
          ),
        );
        const ownerApproved = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId, 'approve'),
            { method: 'POST', body: actionBody(ownerAfterPeer) },
          ),
        );
        expect(ownerApproved).toMatchObject({
          id: completionId,
          phase: 'approved',
          approvalCount: 2,
          requiredApprovals: 2,
          canExecute: true,
        });

        const peerAfterOwner = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId),
            { personaId: 'coapprover' },
          ),
        );
        expect(peerAfterOwner.canExecute).toBe(false);
        const peerExecute = await scenarioRequest<Envelope<Completion>>(
          handle,
          completionPath(sessionId, completionId, 'execute'),
          { method: 'POST', personaId: 'coapprover', body: actionBody(peerAfterOwner) },
        );
        errorOf(peerExecute, 403, 'LIQUIDITY_DENIED');

        const restrictedView = await scenarioRequest<Envelope<Completion>>(
          handle,
          completionPath(sessionId, completionId),
          { personaId: 'restricted' },
        );
        errorOf(restrictedView, 403, 'LIQUIDITY_DENIED');
        const restrictedBody = JSON.stringify(restrictedView.body);
        expect(restrictedBody).not.toContain(completionId);
        expect(restrictedBody).not.toContain(sessionId);
        expect(restrictedBody).not.toContain('2600');
        expect(restrictedBody).not.toContain('1300');

        const beforeExecution = await actualRows(handle);
        const executed = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId, 'execute'),
            { method: 'POST', body: actionBody(ownerApproved) },
          ),
        );
        expect(executed).toMatchObject({
          phase: 'verified',
          manualTransactionId: expect.any(String),
          debit: ownerProposal.debit,
        });
        const afterExecution = await actualRows(handle);
        const parent = afterExecution.find((row) => row.id === executed.manualTransactionId);
        expect(parent).toMatchObject({
          amount: -2600,
          is_parent: true,
          subtransactions: expect.arrayContaining([
            expect.objectContaining({
              category: handle.seeded.categoryIds['cat-groceries'],
              amount: -1300,
              parent_id: executed.manualTransactionId,
            }),
            expect.objectContaining({
              category: handle.seeded.categoryIds['cat-household'],
              amount: -800,
              parent_id: executed.manualTransactionId,
            }),
            expect.objectContaining({
              category: handle.seeded.categoryIds['cat-entertainment'],
              amount: -500,
              parent_id: executed.manualTransactionId,
            }),
          ]),
        });
        expect(parent?.subtransactions).toHaveLength(3);
        expect(actualTotal(afterExecution)).toBe(actualTotal(beforeExecution) - 2600);
      });
    },
  );

  it(
    'import-before-completion applies a real import, closes execution for reconciliation review, and never writes a second debit',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withScenario('import-before-completion', async (handle) => {
        const sessionId = handle.initialized.sessions.purchase;
        const completionId = handle.initialized.completions.purchase;
        if (!sessionId || !completionId)
          throw new Error('Import-before completion IDs were not initialized');
        const event = handle.scenario.events['import-match'];
        if (!event || event.kind !== 'import-match') throw new Error('Expected import-match event');

        const approved = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId),
          ),
        );
        expect(approved).toMatchObject({
          phase: 'approved',
          approvalCount: 1,
          requiredApprovals: 1,
          debit: { amount: -2000 },
        });
        const beforeImport = await actualRows(handle);
        const beforeImportTotal = actualTotal(beforeImport);

        const imported = await applyScenarioEvent({
          scenario: handle.scenario,
          seeded: handle.seeded,
          root: handle.processes.root,
          actualServerUrl: handle.processes.actualUrl,
          actualSecretKey: handle.processes.actualSecretKey,
          eventId: 'import-match',
        });
        expect(imported).toMatchObject({
          eventId: 'import-match',
          kind: 'import-match',
          importedIds: [event.candidate.importedId],
          amounts: [-2000],
        });
        const afterImport = await actualRows(handle);
        const importedRows = allRows(afterImport).filter(
          (row) => importedId(row) === event.candidate.importedId,
        );
        expect(importedRows).toHaveLength(1);
        expect(importedRows[0]).toMatchObject({ amount: -2000, date: event.candidate.date });
        expect(afterImport).toHaveLength(beforeImport.length + 1);
        expect(actualTotal(afterImport)).toBe(beforeImportTotal - 2000);

        const execution = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId, 'execute'),
            { method: 'POST', body: actionBody(approved) },
          ),
        );
        expect(execution).toMatchObject({
          id: completionId,
          phase: 'closed',
          outcome: 'reconciliation_required',
          payloadHash: approved.payloadHash,
          debit: approved.debit,
          manualTransactionId: null,
          importedTransactionId: null,
        });
        expect(execution.reviewRequired).toBe(false);

        const afterExecution = await actualRows(handle);
        expect(afterExecution).toHaveLength(afterImport.length);
        expect(actualTotal(afterExecution)).toBe(beforeImportTotal - 2000);
        expect(
          allRows(afterExecution).filter((row) => importedId(row) === event.candidate.importedId),
        ).toHaveLength(1);

        const retained = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId),
          ),
        );
        expect(retained).toMatchObject({
          id: completionId,
          phase: 'closed',
          outcome: 'reconciliation_required',
          payloadHash: approved.payloadHash,
          debit: approved.debit,
        });
      });
    },
  );

  it(
    'import-after-completion applies Actual import reconciliation and links the existing parent without another debit',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withScenario('import-after-completion', async (handle) => {
        const sessionId = handle.initialized.sessions.purchase;
        const completionId = handle.initialized.completions.purchase;
        if (!sessionId || !completionId)
          throw new Error('Import-after completion IDs were not initialized');
        const event = handle.scenario.events['import-match'];
        if (!event || event.kind !== 'import-match') throw new Error('Expected import-match event');

        const verified = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId),
          ),
        );
        expect(verified).toMatchObject({
          phase: 'verified',
          outcome: null,
          debit: { amount: -2000 },
          manualTransactionId: expect.any(String),
          importedTransactionId: null,
        });
        if (!verified.manualTransactionId)
          throw new Error('Verified completion omitted its Actual parent ID');
        const parentId = verified.manualTransactionId;
        const beforeImport = await actualRows(handle);
        const beforeImportTotal = actualTotal(beforeImport);
        expect(allRows(beforeImport).filter((row) => row.id === parentId)).toHaveLength(1);

        const imported = await applyScenarioEvent({
          scenario: handle.scenario,
          seeded: handle.seeded,
          root: handle.processes.root,
          actualServerUrl: handle.processes.actualUrl,
          actualSecretKey: handle.processes.actualSecretKey,
          eventId: 'import-match',
        });
        expect(imported).toMatchObject({
          eventId: 'import-match',
          kind: 'import-match',
          importedIds: [event.candidate.importedId],
          amounts: [-2000],
        });
        const afterImport = await actualRows(handle);
        const importedRows = allRows(afterImport).filter(
          (row) => importedId(row) === event.candidate.importedId,
        );
        expect(importedRows).toHaveLength(1);
        expect(importedRows[0]).toMatchObject({
          id: parentId,
          amount: -2000,
          date: event.candidate.date,
        });
        expect(afterImport).toHaveLength(beforeImport.length);
        expect(actualTotal(afterImport)).toBe(beforeImportTotal);

        const linked = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId, 'reconcile'),
            { method: 'POST', body: actionBody(verified) },
          ),
        );
        expect(linked).toMatchObject({
          id: completionId,
          phase: 'verified',
          outcome: null,
          manualTransactionId: parentId,
          importedTransactionId: parentId,
          debit: verified.debit,
        });
        const afterReconcile = await actualRows(handle);
        const linkedRows = allRows(afterReconcile).filter((row) => row.id === parentId);
        expect(linkedRows).toHaveLength(1);
        expect(linkedRows[0]).toMatchObject({
          id: parentId,
          amount: -2000,
          imported_id: event.candidate.importedId,
        });
        expect(afterReconcile).toHaveLength(beforeImport.length);
        expect(actualTotal(afterReconcile)).toBe(beforeImportTotal);
      });
    },
  );

  it(
    'ambiguous-completion imports two distinct candidates, refuses normal reconciliation, and preserves one manual debit',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withScenario('ambiguous-completion', async (handle) => {
        const sessionId = handle.initialized.sessions.purchase;
        const completionId = handle.initialized.completions.purchase;
        if (!sessionId || !completionId)
          throw new Error('Ambiguous completion IDs were not initialized');
        const event = handle.scenario.events['import-ambiguous'];
        if (!event || event.kind !== 'import-ambiguous')
          throw new Error('Expected import-ambiguous event');

        const verified = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId),
          ),
        );
        expect(verified).toMatchObject({
          phase: 'verified',
          outcome: null,
          debit: { amount: -2000 },
          manualTransactionId: expect.any(String),
          importedTransactionId: null,
        });
        if (!verified.manualTransactionId)
          throw new Error('Verified completion omitted its Actual parent ID');
        const parentId = verified.manualTransactionId;
        const beforeImport = await actualRows(handle);
        const beforeImportTotal = actualTotal(beforeImport);

        const imported = await applyScenarioEvent({
          scenario: handle.scenario,
          seeded: handle.seeded,
          root: handle.processes.root,
          actualServerUrl: handle.processes.actualUrl,
          actualSecretKey: handle.processes.actualSecretKey,
          eventId: 'import-ambiguous',
        });
        expect(imported).toMatchObject({
          eventId: 'import-ambiguous',
          kind: 'import-ambiguous',
          importedIds: [event.candidates[0]!.importedId, event.candidates[1]!.importedId],
          amounts: [-2000, -2000],
        });
        const afterImport = await actualRows(handle);
        const importedRows = allRows(afterImport).filter((row) =>
          event.candidates.some((candidate) => importedId(row) === candidate.importedId),
        );
        expect(importedRows).toHaveLength(2);
        expect(importedRows.map((row) => row.amount)).toEqual([-2000, -2000]);
        expect(importedRows.map((row) => importedId(row))).toEqual(
          expect.arrayContaining(event.candidates.map((candidate) => candidate.importedId)),
        );
        const parent = allRows(afterImport).find((row) => row.id === parentId);
        expect(parent).toMatchObject({ id: parentId, amount: -2000 });
        expect(importedId(parent ?? {})).toBeNull();
        expect(afterImport).toHaveLength(beforeImport.length + 2);
        expect(actualTotal(afterImport)).toBe(beforeImportTotal - 4000);

        const reconciliation = await scenarioRequest<Envelope<Completion>>(
          handle,
          completionPath(sessionId, completionId, 'reconcile'),
          { method: 'POST', body: actionBody(verified) },
        );
        errorOf(reconciliation, 409, 'LIQUIDITY_REFRESH_REQUIRED');
        const retained = resultOf(
          await scenarioRequest<Envelope<Completion>>(
            handle,
            completionPath(sessionId, completionId),
          ),
        );
        expect(retained).toMatchObject({
          id: completionId,
          phase: 'verified',
          outcome: null,
          manualTransactionId: parentId,
          importedTransactionId: null,
          payloadHash: verified.payloadHash,
        });
        const afterRejectedReconcile = await actualRows(handle);
        expect(afterRejectedReconcile).toHaveLength(afterImport.length);
        expect(actualTotal(afterRejectedReconcile)).toBe(beforeImportTotal - 4000);
      });
    },
  );
});

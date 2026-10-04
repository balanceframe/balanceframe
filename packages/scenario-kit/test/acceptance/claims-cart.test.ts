import { downloadBudget, getAccounts, getTransactions, init, shutdown } from '@actual-app/api';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import type {
  PublicLiquidityConfiguration,
  PublicSessionCompletion,
  PublicSpendSession,
} from '@balanceframe/application';
import type { LoadedScenario } from '../../src/loader.js';
import { scenarioRequest, withScenario } from './support.js';

type Envelope<T> = {
  status: string;
  result?: T | null;
  error?: { code?: string; message?: string } | null;
};

type Money = { minorUnits: string; currency: string };
type SessionItem = PublicSpendSession['items'][number];
type SessionInput = {
  accountId: string | null;
  expiresAt: string;
  items: Array<{
    id: string;
    categoryId: string;
    amount: Money;
    purchaseAt: string;
    requiredBy: string;
    accountId: string | null;
    quantity?: number;
    priority?: 'required' | 'planned' | 'optional';
    categoryAllocations?: Array<{ categoryId: string; amount: Money }>;
    priceProvenance?: SessionItem['priceProvenance'];
    barcode?: string;
  }>;
  adjustments: PublicSpendSession['adjustments'];
  warningThresholds: PublicSpendSession['warningThresholds'];
  expectedVersion?: number;
};

type StoredClaim = {
  claimId: string | null;
  kind: 'reservation' | 'commitment';
  sourceId: string | null;
  scope: { kind: 'category' | 'account'; id: string | null };
  amount: Money | null;
  status: 'active' | 'released';
  mode: 'inform' | 'block';
  lifecycleState: 'active' | 'released' | 'consumed' | 'expired';
};

type ActualRow = Record<string, unknown>;

const money = (minorUnits: string): Money => ({ minorUnits, currency: 'USD' });

function resultOf<T>(response: { status: number; body: unknown }, label: string): T {
  expect(response.status, `${label} HTTP status`).toBe(200);
  const body = response.body as Envelope<T>;
  expect(body.status, `${label} envelope`).toBe('ok');
  expect(body.result, `${label} result`).toBeDefined();
  return body.result as T;
}

function expectInvalid(response: { status: number; body: unknown }, label: string): void {
  expect(response.status, `${label} HTTP status`).toBe(400);
  const body = response.body as Envelope<null>;
  expect(body.status, `${label} envelope`).toBe('error');
  expect(body.error?.code, `${label} error code`).toBe('INVALID_LIQUIDITY_INPUT');
}

function expectConflict(response: { status: number; body: unknown }, label: string): void {
  expect(response.status, `${label} HTTP status`).toBe(409);
  const body = response.body as Envelope<null>;
  expect(body.status, `${label} envelope`).toBe('error');
  expect(body.error?.code, `${label} error code`).toBe('LIQUIDITY_REFRESH_REQUIRED');
}

function categoryId(handle: LoadedScenario, key = 'cat-groceries'): string {
  const id = handle.seeded.categoryIds[key];
  if (!id) throw new Error(`Seeded category is unavailable: ${key}`);
  return id;
}

function accountId(handle: LoadedScenario, key = 'acct-checking'): string {
  const id = handle.seeded.accountIds[key];
  if (!id) throw new Error(`Seeded account is unavailable: ${key}`);
  return id;
}

function claimFor(claims: readonly StoredClaim[], claimId: string): StoredClaim {
  const claim = claims.find((candidate) => candidate.claimId === claimId);
  if (!claim) throw new Error('Expected visible claim is unavailable');
  return claim;
}

function claimSet(handle: LoadedScenario, claims: readonly StoredClaim[]): void {
  expect(claims.length).toBeGreaterThan(0);
  for (const claim of claims) {
    if (claim.claimId)
      expect(claim.sourceId).toContain(`session:${handle.initialized.sessions.cart}`);
  }
}

function mappedSessionInput(handle: LoadedScenario, key: string): SessionInput {
  const source = handle.scenario.sessions[key];
  if (!source) throw new Error(`Scenario session is unavailable: ${key}`);
  const mapCategory = (id: string) => handle.seeded.categoryIds[id] ?? id;
  const mapAccount = (id: string | null) =>
    id === null ? null : (handle.seeded.accountIds[id] ?? id);
  return {
    accountId: mapAccount(source.accountId),
    expiresAt: source.expiresAt,
    items: source.items.map((item) => ({
      id: item.id,
      categoryId: mapCategory(item.categoryId),
      amount: item.amount,
      purchaseAt: item.purchaseAt,
      requiredBy: item.requiredBy,
      accountId: mapAccount(item.accountId),
      ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
      ...(item.priority === undefined ? {} : { priority: item.priority }),
      ...(item.categoryAllocations
        ? {
            categoryAllocations: item.categoryAllocations.map((allocation) => ({
              categoryId: mapCategory(allocation.categoryId),
              amount: allocation.amount,
            })),
          }
        : {}),
      ...(item.priceProvenance === undefined ? {} : { priceProvenance: item.priceProvenance }),
      ...(item.barcode === undefined ? {} : { barcode: item.barcode }),
    })),
    adjustments: (source.adjustments ?? []).map((adjustment) => ({
      ...adjustment,
      categoryId: mapCategory(adjustment.categoryId),
    })),
    warningThresholds: (source.warningThresholds ?? []).map((threshold) =>
      threshold.basis === 'category_charge'
        ? { ...threshold, categoryId: mapCategory(threshold.categoryId) }
        : threshold,
    ),
  };
}

function sessionInputFromView(
  session: PublicSpendSession,
  expectedVersion = session.version,
): SessionInput {
  return {
    accountId: session.accountId,
    expiresAt: session.expiresAt,
    items: session.items.map((item) => ({
      id: item.id,
      categoryId: item.categoryId,
      amount: item.amount,
      purchaseAt: item.purchaseAt,
      requiredBy: item.requiredBy,
      accountId: item.accountId,
      ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
      ...(item.priority === undefined ? {} : { priority: item.priority }),
      ...(item.categoryAllocations ? { categoryAllocations: item.categoryAllocations } : {}),
      ...(item.priceProvenance === undefined ? {} : { priceProvenance: item.priceProvenance }),
      ...(item.barcode === undefined ? {} : { barcode: item.barcode }),
    })),
    adjustments: session.adjustments,
    warningThresholds: session.warningThresholds,
    expectedVersion,
  };
}

function updateBody(
  session: PublicSpendSession,
  mutate: (items: SessionInput['items']) => SessionInput['items'] = (items) => items,
): SessionInput {
  const input = sessionInputFromView(session);
  return { ...input, items: mutate(input.items) };
}

async function createCompetingSession(
  handle: LoadedScenario,
  itemId: string,
  amount = '1000',
  expiresAt = new Date(Date.now() + 60_000).toISOString(),
): Promise<PublicSpendSession> {
  const now = new Date().toISOString();
  const body: SessionInput = {
    accountId: accountId(handle),
    expiresAt,
    items: [
      {
        id: itemId,
        categoryId: categoryId(handle),
        amount: money(amount),
        purchaseAt: now,
        requiredBy: now,
        accountId: accountId(handle),
        priority: 'required',
      },
    ],
    adjustments: [],
    warningThresholds: [],
  };
  return resultOf<PublicSpendSession>(
    await scenarioRequest<unknown>(handle, '/api/spend-sessions', { method: 'POST', body }),
    `create ${itemId}`,
  );
}

function policyUpdate(
  configuration: PublicLiquidityConfiguration,
  reservationMode: 'inform' | 'block',
): Record<string, unknown> {
  const policy = configuration.policy;
  if (!policy || !configuration.approvalPolicy) throw new Error('Scenario policy is unavailable');
  return {
    expectedVersion: policy.version,
    expiresAt: policy.expiresAt,
    reservationMode,
    accounts: policy.accounts.map(({ resourceScope: _resourceScope, ...account }) => account),
    transferRoutes: policy.transferRoutes.map(({ evidence: _evidence, ...route }) => route),
    ...(policy.categoryPolicies ? { categoryPolicies: policy.categoryPolicies } : {}),
    approvalPolicy: configuration.approvalPolicy,
  };
}

/** Real wall-clock delay is intentional: the child workflow and Actual clocks must observe expiry. */
async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readActualTransactions(handle: LoadedScenario): Promise<ActualRow[]> {
  const dataDir = mkdtempSync(join(tmpdir(), 'balanceframe-claims-cart-readback-'));
  let opened = false;
  try {
    await init({
      serverURL: handle.processes.actualUrl,
      password: handle.processes.actualSecretKey,
      dataDir,
    });
    opened = true;
    await downloadBudget(handle.seeded.groupId);
    const accounts = (await getAccounts()) as Array<{ id?: string }>;
    const rows: ActualRow[] = [];
    for (const account of accounts) {
      if (typeof account.id !== 'string') continue;
      rows.push(...((await getTransactions(account.id)) as ActualRow[]));
    }
    return rows;
  } finally {
    if (opened) await shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function waitForClaimExpiry(
  handle: LoadedScenario,
  claimId: string,
  expiresAt: string,
): Promise<StoredClaim> {
  const expiry = Date.parse(expiresAt);
  const deadline = expiry + 15_000;
  while (Date.now() < expiry) {
    const claims = resultOf<StoredClaim[]>(
      await scenarioRequest<unknown>(handle, '/api/liquidity/claims'),
      'poll active claim',
    );
    const claim = claims.find((candidate) => candidate.claimId === claimId);
    if (claim?.lifecycleState === 'expired') return claim;
    await wait(100);
  }
  while (Date.now() < deadline) {
    const claims = resultOf<StoredClaim[]>(
      await scenarioRequest<unknown>(handle, '/api/liquidity/claims'),
      'poll expired claim',
    );
    const claim = claims.find((candidate) => candidate.claimId === claimId);
    if (claim?.lifecycleState === 'expired') return claim;
    await wait(100);
  }
  throw new Error('Claim did not reach expired lifecycle state before the observed deadline');
}

describe('claims and cart scenario acceptance', () => {
  it('reservation-block prevents reuse, supports idempotent create/release, and restores exact capacity on expiry', async () => {
    await withScenario('reservation-block', async (handle) => {
      const sessionId = handle.initialized.sessions.cart;
      const initialClaims = resultOf<StoredClaim[]>(
        await scenarioRequest<unknown>(handle, '/api/liquidity/claims'),
        'reservation block claims',
      );
      claimSet(handle, initialClaims);
      const originalId = handle.initialized.claims.reserve;
      const original = claimFor(initialClaims, originalId);
      expect(original).toMatchObject({
        claimId: originalId,
        kind: 'reservation',
        scope: { kind: 'category', id: categoryId(handle) },
        amount: money('1500'),
        mode: 'block',
        status: 'active',
        lifecycleState: 'active',
      });

      const competing = await createCompetingSession(handle, 'reservation-block-competing');
      expect(competing.card.outcome).not.toBe('funded_now');
      expect(competing.card.budgetFundingStatus).not.toBe('funded');

      const released = resultOf<StoredClaim>(
        await scenarioRequest<unknown>(
          handle,
          `/api/liquidity/claims/${encodeURIComponent(originalId)}/release`,
          {
            method: 'POST',
            body: { idempotencyKey: 'reservation-block-release-original' },
          },
        ),
        'release original reservation',
      );
      expect(released).toMatchObject({
        claimId: originalId,
        status: 'released',
        lifecycleState: 'released',
      });
      const replayedRelease = resultOf<StoredClaim>(
        await scenarioRequest<unknown>(
          handle,
          `/api/liquidity/claims/${encodeURIComponent(originalId)}/release`,
          {
            method: 'POST',
            body: { idempotencyKey: 'reservation-block-release-original' },
          },
        ),
        'replay original reservation release',
      );
      expect(replayedRelease).toMatchObject({
        claimId: originalId,
        status: 'released',
        lifecycleState: 'released',
      });
      const restored = await scenarioRequest<PublicSpendSession>(
        handle,
        `/api/spend-sessions/${competing.id}`,
      );
      const restoredSession = resultOf<PublicSpendSession>(
        restored,
        'released reservation re-evaluation',
      );
      expect(restoredSession.card.outcome).toBe('funded_now');
      expect(restoredSession.card.cart?.total).toEqual(money('1000'));

      const createBody = {
        sessionId,
        expectedSessionVersion: 1,
        kind: 'reservation' as const,
        scope: { kind: 'category' as const, id: categoryId(handle) },
        idempotencyKey: 'reservation-block-create-replay',
      };
      const created = resultOf<StoredClaim>(
        await scenarioRequest<unknown>(handle, '/api/liquidity/claims', {
          method: 'POST',
          body: createBody,
        }),
        'create replayable reservation',
      );
      const replayedCreate = resultOf<StoredClaim>(
        await scenarioRequest<unknown>(handle, '/api/liquidity/claims', {
          method: 'POST',
          body: createBody,
        }),
        'replay reservation create',
      );
      expect(created).toMatchObject({
        kind: 'reservation',
        amount: money('1500'),
        mode: 'block',
        status: 'active',
        lifecycleState: 'active',
      });
      expect(replayedCreate).toMatchObject({
        claimId: created.claimId,
        amount: money('1500'),
        lifecycleState: 'active',
      });
      const releasedReplayable = resultOf<StoredClaim>(
        await scenarioRequest<unknown>(
          handle,
          `/api/liquidity/claims/${encodeURIComponent(created.claimId!)}/release`,
          {
            method: 'POST',
            body: { idempotencyKey: 'reservation-block-release-replayable' },
          },
        ),
        'release replayable reservation',
      );
      expect(releasedReplayable.lifecycleState).toBe('released');

      const shortExpiresAt = new Date(Date.now() + 10_000).toISOString();
      const shortSession = await createCompetingSession(
        handle,
        'reservation-block-expiring-source',
        '1500',
        shortExpiresAt,
      );
      const shortClaim = resultOf<StoredClaim>(
        await scenarioRequest<unknown>(handle, '/api/liquidity/claims', {
          method: 'POST',
          body: {
            sessionId: shortSession.id,
            expectedSessionVersion: shortSession.version,
            kind: 'reservation',
            scope: { kind: 'category', id: categoryId(handle) },
            idempotencyKey: 'reservation-block-expiring-claim',
          },
        }),
        'create expiring reservation',
      );
      expect(shortClaim).toMatchObject({
        amount: money('1500'),
        status: 'active',
        lifecycleState: 'active',
      });
      const blockedByExpiringClaim = await createCompetingSession(
        handle,
        'reservation-block-expiry-blocked',
      );
      expect(blockedByExpiringClaim.card.outcome).not.toBe('funded_now');
      const expired = await waitForClaimExpiry(handle, shortClaim.claimId!, shortClaim.expiresAt);
      expect(expired).toMatchObject({
        claimId: shortClaim.claimId,
        amount: money('1500'),
        status: 'released',
        lifecycleState: 'expired',
      });
      const afterExpiry = await createCompetingSession(handle, 'reservation-block-expiry-restored');
      expect(afterExpiry.card.outcome).toBe('funded_now');
      expect(afterExpiry.card.cart?.total).toEqual(money('1000'));
    });
  }, 180_000);

  it('reservation-inform remains visible without reducing capacity, then policy blocking takes effect and release restores it', async () => {
    await withScenario('reservation-inform', async (handle) => {
      const claims = resultOf<StoredClaim[]>(
        await scenarioRequest<unknown>(handle, '/api/liquidity/claims'),
        'reservation inform claims',
      );
      const reservation = claimFor(claims, handle.initialized.claims.reserve);
      expect(reservation).toMatchObject({
        kind: 'reservation',
        scope: { kind: 'category', id: categoryId(handle) },
        amount: money('1500'),
        mode: 'inform',
        status: 'active',
        lifecycleState: 'active',
      });

      const competing = await createCompetingSession(handle, 'reservation-inform-competing');
      expect(competing.card.outcome).toBe('funded_now');
      expect(competing.card.budgetFundingStatus).toBe('funded');
      expect(competing.card.paymentLiquidityStatus).toBe('ready');
      expect(competing.card.cart?.total).toEqual(money('1000'));

      const current = resultOf<PublicLiquidityConfiguration>(
        await scenarioRequest<unknown>(handle, '/api/liquidity/policy'),
        'read informing policy',
      );
      const blocked = resultOf<PublicLiquidityConfiguration>(
        await scenarioRequest<unknown>(handle, '/api/liquidity/policy', {
          method: 'PUT',
          body: policyUpdate(current, 'block'),
        }),
        'switch reservation policy to block',
      );
      expect(blocked.policy?.reservationMode).toBe('block');

      const blockedView = resultOf<PublicSpendSession>(
        await scenarioRequest<unknown>(handle, `/api/spend-sessions/${competing.id}`),
        'blocked reservation re-evaluation',
      );
      expect(blockedView.card.outcome).not.toBe('funded_now');
      expect(blockedView.card.budgetFundingStatus).not.toBe('funded');

      const released = resultOf<StoredClaim>(
        await scenarioRequest<unknown>(
          handle,
          `/api/liquidity/claims/${encodeURIComponent(handle.initialized.claims.reserve)}/release`,
          { method: 'POST', body: { idempotencyKey: 'reservation-inform-release' } },
        ),
        'release informing reservation',
      );
      expect(released).toMatchObject({ status: 'released', lifecycleState: 'released' });
      const restored = resultOf<PublicSpendSession>(
        await scenarioRequest<unknown>(handle, `/api/spend-sessions/${competing.id}`),
        'released informing reservation re-evaluation',
      );
      expect(restored.card.outcome).toBe('funded_now');
      expect(restored.card.cart?.total).toEqual(money('1000'));
    });
  }, 180_000);

  it('commitment-overlap blocks category and account reuse, consumes both prospective holds on one completion, and never debits twice', async () => {
    await withScenario('commitment-overlap', async (handle) => {
      const claims = resultOf<StoredClaim[]>(
        await scenarioRequest<unknown>(handle, '/api/liquidity/claims'),
        'commitment claims',
      );
      expect(claims).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            claimId: handle.initialized.claims.categoryCommitment,
            kind: 'commitment',
            scope: { kind: 'category', id: categoryId(handle) },
            amount: money('1500'),
            mode: 'block',
            lifecycleState: 'active',
          }),
          expect.objectContaining({
            claimId: handle.initialized.claims.accountCommitment,
            kind: 'commitment',
            scope: { kind: 'account', id: accountId(handle) },
            amount: money('1500'),
            mode: 'block',
            lifecycleState: 'active',
          }),
        ]),
      );

      const categoryAndAccountCompetitor = await createCompetingSession(
        handle,
        'commitment-overlap-competing',
      );
      expect(categoryAndAccountCompetitor.card.outcome).not.toBe('funded_now');
      expect(categoryAndAccountCompetitor.card.budgetFundingStatus).not.toBe('funded');

      const sessionId = handle.initialized.sessions.origin;
      const completionId = handle.initialized.completions.originCompletion;
      const proposed = resultOf<PublicSessionCompletion>(
        await scenarioRequest<unknown>(
          handle,
          `/api/spend-sessions/${sessionId}/completions/${encodeURIComponent(completionId)}`,
        ),
        'read originating completion',
      );
      expect(proposed).toMatchObject({
        id: completionId,
        phase: 'proposed',
        debit: {
          accountId: accountId(handle),
          amount: -1500,
          categoryCharges: [{ categoryId: categoryId(handle), amount: money('1500') }],
        },
      });
      expect(proposed.payloadHash).toMatch(/^[a-f0-9]{64}$/);
      const beforeRows = await readActualTransactions(handle);
      const beforeIds = new Set(
        beforeRows.flatMap((row) => (typeof row.id === 'string' ? [row.id] : [])),
      );

      const approved = resultOf<PublicSessionCompletion>(
        await scenarioRequest<unknown>(
          handle,
          `/api/spend-sessions/${sessionId}/completions/${encodeURIComponent(completionId)}/approve`,
          {
            method: 'POST',
            personaId: 'approver',
            body: {
              payloadHash: proposed.payloadHash,
              expectedVersion: proposed.version,
              idempotencyKey: 'commitment-overlap-approval',
            },
          },
        ),
        'approve originating completion',
      );
      expect(approved.phase).toBe('approved');
      expect(approved.debit?.amount).toBe(-1500);
      expect(approved.canExecute).toBe(false);
      const executed = resultOf<PublicSessionCompletion>(
        await scenarioRequest<unknown>(
          handle,
          `/api/spend-sessions/${sessionId}/completions/${encodeURIComponent(completionId)}/execute`,
          {
            method: 'POST',
            body: {
              payloadHash: proposed.payloadHash,
              expectedVersion: approved.version,
              idempotencyKey: 'commitment-overlap-execute',
            },
          },
        ),
        'execute originating completion',
      );
      expect(executed).toMatchObject({
        id: completionId,
        phase: 'verified',
        outcome: null,
        manualTransactionId: expect.any(String),
        debit: {
          accountId: accountId(handle),
          amount: -1500,
          categoryCharges: [{ categoryId: categoryId(handle), amount: money('1500') }],
        },
      });

      const afterRows = await readActualTransactions(handle);
      const newRows = afterRows.filter(
        (row) => typeof row.id === 'string' && !beforeIds.has(row.id),
      );
      expect(newRows).toHaveLength(1);
      expect(newRows[0]).toMatchObject({
        id: executed.manualTransactionId,
        account: accountId(handle),
        amount: -1500,
        category: categoryId(handle),
      });

      const completedClaims = resultOf<StoredClaim[]>(
        await scenarioRequest<unknown>(handle, '/api/liquidity/claims'),
        'read consumed commitments',
      );
      expect(claimFor(completedClaims, handle.initialized.claims.categoryCommitment)).toMatchObject(
        {
          status: 'released',
          lifecycleState: 'consumed',
          amount: money('1500'),
        },
      );
      expect(claimFor(completedClaims, handle.initialized.claims.accountCommitment)).toMatchObject({
        status: 'released',
        lifecycleState: 'consumed',
        amount: money('1500'),
      });

      const replay = resultOf<PublicSessionCompletion>(
        await scenarioRequest<unknown>(
          handle,
          `/api/spend-sessions/${sessionId}/completions/${encodeURIComponent(completionId)}/execute`,
          {
            method: 'POST',
            body: {
              payloadHash: proposed.payloadHash,
              expectedVersion: executed.version,
              idempotencyKey: 'commitment-overlap-execute-replay',
            },
          },
        ),
        'replay originating completion execution',
      );
      expect(replay).toMatchObject({
        phase: 'verified',
        outcome: null,
        manualTransactionId: executed.manualTransactionId,
      });
      const replayRows = await readActualTransactions(handle);
      expect(replayRows.filter((row) => row.id === executed.manualTransactionId)).toHaveLength(1);
    });
  }, 180_000);

  it('rich-cart evaluates quantity, adjustments, optional trim, threshold excess, real edits, and reset totals exactly', async () => {
    await withScenario('rich-cart', async (handle) => {
      const sessionId = handle.initialized.sessions.cart;
      const initial = resultOf<PublicSpendSession>(
        await scenarioRequest<unknown>(handle, `/api/spend-sessions/${sessionId}`),
        'read rich cart',
      );
      expect(initial.items).toHaveLength(2);
      expect(initial.items[0]).toMatchObject({
        id: 'required-groceries',
        quantity: 2,
        priority: 'required',
        amount: money('1000'),
      });
      expect(initial.items[1]).toMatchObject({
        id: 'optional-entertainment',
        priority: 'optional',
        amount: money('500'),
      });
      expect(initial.adjustments).toEqual([
        { kind: 'tax', categoryId: categoryId(handle), amount: money('100') },
        { kind: 'fee', categoryId: categoryId(handle), amount: money('50') },
        { kind: 'discount', categoryId: categoryId(handle), amount: money('50') },
      ]);
      expect(initial.warningThresholds).toEqual([
        { id: 'cart-threshold', basis: 'cart_total', maximum: money('2500') },
      ]);
      expect(initial.card.outcome).toBe('funded_now');
      expect(initial.card.cart).toMatchObject({
        subtotal: money('2500'),
        tax: money('100'),
        fee: money('50'),
        discount: money('50'),
        total: money('2600'),
        categoryCharges: expect.arrayContaining([
          { categoryId: categoryId(handle), amount: money('2100') },
          { categoryId: categoryId(handle, 'cat-entertainment'), amount: money('500') },
        ]),
        accountCharges: [{ accountId: accountId(handle), amount: money('2600') }],
      });
      expect(initial.card.warnings).toEqual([
        expect.objectContaining({
          thresholdId: 'cart-threshold',
          threshold: money('2500'),
          actual: money('2600'),
          excess: money('100'),
          alternatives: [
            expect.objectContaining({
              removedItemIds: ['optional-entertainment'],
              retainedItemIds: ['required-groceries'],
              total: money('2100'),
              outcome: 'funded_now',
            }),
          ],
        }),
      ]);
      expect(initial.card.trimAlternatives).toEqual([
        expect.objectContaining({
          removedItemIds: ['optional-entertainment'],
          retainedItemIds: ['required-groceries'],
          total: money('2100'),
          outcome: 'funded_now',
        }),
      ]);

      const quantityChanged = resultOf<PublicSpendSession>(
        await scenarioRequest<unknown>(handle, `/api/spend-sessions/${sessionId}`, {
          method: 'PUT',
          body: updateBody(initial, (items) =>
            items.map((item) =>
              item.id === 'required-groceries'
                ? {
                    ...item,
                    quantity: 3,
                    categoryAllocations: [
                      { categoryId: categoryId(handle), amount: money('3000') },
                    ],
                  }
                : item,
            ),
          ),
        }),
        'change required quantity',
      );
      expect(quantityChanged.card.cart?.total).toEqual(money('3600'));
      expect(quantityChanged.items.find((item) => item.id === 'required-groceries')?.quantity).toBe(
        3,
      );

      const added = resultOf<PublicSpendSession>(
        await scenarioRequest<unknown>(handle, `/api/spend-sessions/${sessionId}`, {
          method: 'PUT',
          body: updateBody(quantityChanged, (items) => [
            ...items,
            {
              id: 'added-groceries',
              categoryId: categoryId(handle),
              amount: money('200'),
              purchaseAt: new Date().toISOString(),
              requiredBy: new Date().toISOString(),
              accountId: accountId(handle),
              quantity: 1,
              priority: 'required',
            },
          ]),
        }),
        'add required cart item',
      );
      expect(added.items).toHaveLength(3);
      expect(added.card.cart?.total).toEqual(money('3800'));

      const removed = resultOf<PublicSpendSession>(
        await scenarioRequest<unknown>(handle, `/api/spend-sessions/${sessionId}`, {
          method: 'PUT',
          body: updateBody(added, (items) => items.filter((item) => item.id !== 'added-groceries')),
        }),
        'remove added cart item',
      );
      expect(removed.items).toHaveLength(2);
      expect(removed.card.cart?.total).toEqual(money('3600'));

      const reset = resultOf<PublicSpendSession>(
        await scenarioRequest<unknown>(handle, `/api/spend-sessions/${sessionId}`, {
          method: 'PUT',
          body: updateBody(removed, (items) =>
            items.map((item) =>
              item.id === 'required-groceries'
                ? {
                    ...item,
                    quantity: 2,
                    categoryAllocations: [
                      { categoryId: categoryId(handle), amount: money('2000') },
                    ],
                  }
                : item,
            ),
          ),
        }),
        'reset rich cart',
      );
      expect(reset.items.find((item) => item.id === 'required-groceries')?.quantity).toBe(2);
      expect(reset.items).toHaveLength(2);
      expect(reset.card.cart?.total).toEqual(money('2600'));
      expect(reset.card.cart?.categoryCharges).toEqual(
        expect.arrayContaining([
          { categoryId: categoryId(handle), amount: money('2100') },
          { categoryId: categoryId(handle, 'cat-entertainment'), amount: money('500') },
        ]),
      );
    });
  }, 180_000);

  it('required-item-overage warns by one dollar without optional or required-item trim recommendations', async () => {
    await withScenario('required-item-overage', async (handle) => {
      const session = resultOf<PublicSpendSession>(
        await scenarioRequest<unknown>(
          handle,
          `/api/spend-sessions/${handle.initialized.sessions.requiredOnly}`,
        ),
        'read required-only cart',
      );
      expect(session.items).toEqual([
        expect.objectContaining({
          id: 'required-groceries',
          quantity: 2,
          priority: 'required',
          amount: money('1000'),
        }),
      ]);
      expect(session.adjustments).toEqual([
        { kind: 'tax', categoryId: categoryId(handle), amount: money('100') },
      ]);
      expect(session.card.outcome).toBe('funded_now');
      expect(session.card.cart).toMatchObject({
        subtotal: money('2000'),
        tax: money('100'),
        fee: money('0'),
        discount: money('0'),
        total: money('2100'),
        categoryCharges: [{ categoryId: categoryId(handle), amount: money('2100') }],
        accountCharges: [{ accountId: accountId(handle), amount: money('2100') }],
      });
      expect(session.card.warnings).toEqual([
        expect.objectContaining({
          thresholdId: 'required-threshold',
          threshold: money('2000'),
          actual: money('2100'),
          excess: money('100'),
          alternatives: [],
        }),
      ]);
      expect(session.card.trimAlternatives).toEqual([]);
    });
  }, 180_000);

  it('outside-price preserves explicit provenance and rejects missing source or amount instead of using a barcode', async () => {
    await withScenario('outside-price', async (handle) => {
      const sessionId = handle.initialized.sessions.outside;
      const initial = resultOf<PublicSpendSession>(
        await scenarioRequest<unknown>(handle, `/api/spend-sessions/${sessionId}`),
        'read outside-price cart',
      );
      const item = initial.items[0];
      expect(item).toMatchObject({
        id: 'outside-groceries',
        amount: money('2000'),
        priceProvenance: {
          kind: 'outside_price',
          source: 'fixture-price',
          store: 'Market Basket',
          observedAt: handle.scenario.anchor,
          estimate: true,
        },
      });
      expect(initial.card.outcome).toBe('funded_now');
      expect(initial.card.cart?.total).toEqual(money('2000'));

      const sourceMissing = updateBody(initial, (items) =>
        items.map((candidate) =>
          candidate.id === 'outside-groceries'
            ? {
                ...candidate,
                barcode: '0123456789012',
                priceProvenance: {
                  kind: 'outside_price' as const,
                  source: '',
                  store: 'Market Basket',
                  observedAt: handle.scenario.anchor,
                  estimate: true,
                },
              }
            : candidate,
        ),
      );
      expectInvalid(
        await scenarioRequest<unknown>(handle, `/api/spend-sessions/${sessionId}`, {
          method: 'PUT',
          body: sourceMissing,
        }),
        'missing outside price source',
      );

      const amountMissing = updateBody(initial, (items) =>
        items.map((candidate) =>
          candidate.id === 'outside-groceries'
            ? {
                ...candidate,
                barcode: '0123456789012',
                amount: { minorUnits: '', currency: 'USD' },
              }
            : candidate,
        ),
      );
      expectInvalid(
        await scenarioRequest<unknown>(handle, `/api/spend-sessions/${sessionId}`, {
          method: 'PUT',
          body: amountMissing,
        }),
        'missing outside price amount',
      );

      const unchanged = resultOf<PublicSpendSession>(
        await scenarioRequest<unknown>(handle, `/api/spend-sessions/${sessionId}`),
        'read outside-price cart after invalid edits',
      );
      expect(unchanged.version).toBe(initial.version);
      expect(unchanged.items[0]).toMatchObject({
        amount: money('2000'),
        priceProvenance: expect.objectContaining({
          kind: 'outside_price',
          source: 'fixture-price',
        }),
      });
      expect(unchanged.card.outcome).toBe('funded_now');
      expect(unchanged.card.cart?.total).toEqual(money('2000'));
    });
  }, 180_000);

  it('expired-session rejects active reads, edits, claims, and proposals after its observed deadline, then creates a fresh identity', async () => {
    await withScenario('expired-session', async (handle) => {
      const sessionId = handle.initialized.sessions.expired;
      const recipe = handle.scenario.sessions.expired;
      if (!recipe) throw new Error('Expired session recipe is unavailable');
      expect(Date.parse(recipe.expiresAt) - Date.parse(handle.scenario.anchor)).toBe(2_000);
      let expiredRead = await scenarioRequest<unknown>(
        handle,
        `/api/spend-sessions/${sessionId}`,
      );
      let observedExpiry: number | undefined;
      while (expiredRead.status === 200) {
        const active = resultOf<PublicSpendSession>(expiredRead, 'read expiring session');
        observedExpiry = Date.parse(active.expiresAt);
        expect(active.canEdit).toBe(true);
        await wait(100);
        expiredRead = await scenarioRequest<unknown>(
          handle,
          `/api/spend-sessions/${sessionId}`,
        );
      }
      if (observedExpiry !== undefined) expect(Date.now()).toBeGreaterThanOrEqual(observedExpiry);
      expectConflict(expiredRead, 'expired session read');

      const edit = mappedSessionInput(handle, 'expired');
      edit.expiresAt = new Date(Date.now() + 60_000).toISOString();
      edit.expectedVersion = 1;
      expectConflict(
        await scenarioRequest<unknown>(handle, `/api/spend-sessions/${sessionId}`, {
          method: 'PUT',
          body: edit,
        }),
        'expired session edit',
      );
      expectConflict(
        await scenarioRequest<unknown>(handle, '/api/liquidity/claims', {
          method: 'POST',
          body: {
            sessionId,
            expectedSessionVersion: 1,
            kind: 'reservation',
            scope: { kind: 'category', id: categoryId(handle) },
            idempotencyKey: 'expired-session-claim',
          },
        }),
        'expired session claim',
      );
      expectConflict(
        await scenarioRequest<unknown>(handle, `/api/spend-sessions/${sessionId}/completions`, {
          method: 'POST',
          body: { expectedSessionVersion: 1, idempotencyKey: 'expired-session-proposal' },
        }),
        'expired session proposal',
      );

      const freshBody = mappedSessionInput(handle, 'expired');
      freshBody.expiresAt = new Date(Date.now() + 60_000).toISOString();
      delete freshBody.expectedVersion;
      const fresh = resultOf<PublicSpendSession>(
        await scenarioRequest<unknown>(handle, '/api/spend-sessions', {
          method: 'POST',
          body: freshBody,
        }),
        'reset expired session identity',
      );
      expect(fresh.id).not.toBe(sessionId);
      expect(fresh.version).toBe(1);
      expect(fresh.canEdit).toBe(true);
      expect(fresh.card.outcome).toBe('funded_now');
      const freshRead = resultOf<PublicSpendSession>(
        await scenarioRequest<unknown>(handle, `/api/spend-sessions/${fresh.id}`),
        'read reset session identity',
      );
      expect(freshRead.id).toBe(fresh.id);
      expect(freshRead.card.outcome).toBe('funded_now');
    });
  }, 180_000);
});

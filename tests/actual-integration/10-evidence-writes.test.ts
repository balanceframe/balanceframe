import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  DeriveEvidenceSettlementPlanRequestSchema,
  EvidenceSettlementPlanSchema,
} from '@balanceframe/protocol-generated/validators';
import {
  ActualConnector,
  NullCredentialStore,
  createDefaultActualClient,
} from '@balanceframe/actual-adapter';
import type { ManualTransactionInput } from '@balanceframe/actual-adapter';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';
import { populateActualBudget } from '../../packages/scenario-kit/src/actual-seed.js';
import { addTransactions, getBudgets, sync, deleteBudget } from './actual-client.js';
import { assertFixtureProvenance, createTestBudget, withActualClient } from './helpers.js';
import type { ClientConfig, SeededBudget } from './helpers.js';

// Every mutation is confined to a newly created, canonically seeded disposable budget.
// This exercises the same bounded writer/fence port used after application approval.
describe('10 — real SDK evidence credits and exact settlement amendments', () => {
  it('rereads credit and split writes, preserves imported metadata, and refuses SDK-inherited metadata changes before dispatch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'balanceframe-evidence-sdk-'));
    mkdirSync(join(directory, 'seed'));
    mkdirSync(join(directory, 'cleanup'));
    let created: SeededBudget | null = null;
    let seedConfig: ClientConfig | null = null;
    let connector: ActualConnector | null = null;
    const parentId = randomUUID(),
      oneChildParentId = randomUUID(),
      aggregateParentId = randomUUID(),
      oneChildId = randomUUID();
    const marker = `synthetic-evidence-${randomUUID()}`;
    try {
      const seeded = await withActualClient(
        async (config) => {
          seedConfig = config;
          expect(config.serverURL).toBe(assertFixtureProvenance().serverURL);
          const budget = await createTestBudget(`BalanceFrame-Evidence-Only-${randomUUID()}`);
          created = budget;
          const source = JSON.parse(
            readFileSync(
              new URL('../../protocol/fixtures/representative.json', import.meta.url),
              'utf8',
            ),
          ) as ProtocolSnapshot;
          const ids = await populateActualBudget(source);
          const account = source.accounts.find(
            (account) => !account.offBudget && !account.isClosed,
          )!;
          const categories = source.categories.filter(
            (category) => !category.isIncome && !category.deleted,
          );
          const payee = source.payees.find((payee) => payee.transferAccountId === null)!;
          const accountId = ids.accountIds[account.id]!,
            categoryId = ids.categoryIds[categories[0]!.id]!,
            otherCategoryId = ids.categoryIds[categories[1]!.id]!,
            payeeId = ids.payeeIds[payee.id]!;
          const date = source.snapshotDate.slice(0, 10);
          const syntheticTransactions = [
            {
              id: parentId,
              account: accountId,
              date,
              amount: -12500,
              category: categoryId,
              payee: payeeId,
              notes: 'Synthetic imported settlement note',
              imported_id: `${marker}-bank`,
              imported_payee: 'Synthetic imported payee',
              cleared: true,
              reconciled: false,
            },
            {
              id: oneChildParentId,
              account: accountId,
              date,
              amount: -12500,
              category: null,
              payee: payeeId,
              notes: 'Synthetic one-child settlement note',
              imported_id: `${marker}-one-child-bank`,
              imported_payee: 'Synthetic one-child imported payee',
              cleared: true,
              reconciled: false,
              is_parent: true,
              subtransactions: [
                {
                  id: oneChildId,
                  account: accountId,
                  date,
                  amount: -12500,
                  category: categoryId,
                  payee: payeeId,
                  notes: 'Synthetic child note',
                  cleared: true,
                  reconciled: false,
                },
              ],
            },
            {
              id: aggregateParentId,
              account: accountId,
              date,
              amount: -1200,
              category: categoryId,
              payee: payeeId,
              notes: 'Synthetic aggregate settlement note',
              imported_id: `${marker}-aggregate-bank`,
              imported_payee: 'Synthetic aggregate imported payee',
              cleared: true,
              reconciled: false,
            },
          ];
          // The SDK import declaration omits raw identity/metadata and nullable category
          // fields that its runtime supports; these exact fields are the fixture under test.
          await addTransactions(
            accountId,
            syntheticTransactions as Parameters<typeof addTransactions>[1],
            {
              runTransfers: false,
              learnCategories: false,
            },
          );
          await sync();
          const remote = (await getBudgets()).find(
            (item) => item.name === budget.budgetName && item.groupId === budget.groupId,
          )!;
          return {
            config,
            budgetId: remote.cloudFileId ?? remote.id!,
            accountId,
            categoryId,
            otherCategoryId,
            payeeName: payee.name,
            date,
          };
        },
        { dataDir: join(directory, 'seed') },
      );
      const client = await createDefaultActualClient();
      const sdkUpdate = client.updateTransaction.bind(client);
      const update = vi.spyOn(client, 'updateTransaction');
      const add = vi.spyOn(client, 'addTransactions');
      connector = new ActualConnector({
        client,
        credentialStore: new NullCredentialStore(),
        mode: 'disposableSandbox',
        cacheDir: join(directory, 'writer'),
      });
      await connector.connect({
        serverUrl: seeded.config.serverURL,
        secretKey: seeded.config.password,
      });
      await connector.selectBudget(seeded.budgetId);
      const fence = vi.fn();
      const authority = { budgetId: seeded.budgetId, assertExecutionCurrent: fence };
      const credit: ManualTransactionInput = {
        parentId: randomUUID(),
        correlationId: randomUUID(),
        accountId: seeded.accountId,
        date: seeded.date,
        amount: 12500,
        categoryId: null,
        payeeName: seeded.payeeName,
        notes: 'Synthetic reviewed credit',
        splits: [
          {
            accountId: seeded.accountId,
            date: seeded.date,
            amount: 12500,
            categoryId: seeded.categoryId,
          },
        ],
      };
      const creditResult = await connector.createEvidenceCredit(credit, authority);
      expect(creditResult, JSON.stringify(creditResult)).toMatchObject({
        success: true,
        verified: true,
      });
      expect(fence).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledTimes(1);
      const creditRead = await connector.captureEvidenceTransaction({
        budgetId: seeded.budgetId,
        accountId: seeded.accountId,
        transactionId: credit.parentId,
      });
      expect(creditRead.parent).toMatchObject({
        amount: 12500,
        notes: credit.notes,
        is_parent: true,
      });
      expect(creditRead.children).toHaveLength(1);
      expect(creditRead.children[0]).toMatchObject({ amount: 12500, category: seeded.categoryId });
      const before = await connector.captureEvidenceTransaction({
        budgetId: seeded.budgetId,
        accountId: seeded.accountId,
        transactionId: parentId,
      });
      const amendment: ManualTransactionInput = {
        parentId,
        correlationId: randomUUID(),
        accountId: seeded.accountId,
        date: seeded.date,
        amount: -12500,
        categoryId: null,
        payeeName: seeded.payeeName,
        notes: 'Synthetic imported settlement note',
        splits: [
          {
            accountId: seeded.accountId,
            date: seeded.date,
            amount: -7500,
            categoryId: seeded.categoryId,
          },
          {
            accountId: seeded.accountId,
            date: seeded.date,
            amount: -5000,
            categoryId: seeded.otherCategoryId,
          },
        ],
      };
      await sdkUpdate(parentId, { ...before.parent, cleared: false });
      await client.sync();
      const stale = await connector.amendEvidenceTransaction(
        { expected: before, transaction: amendment },
        authority,
      );
      expect(stale).toMatchObject({ success: false, code: 'SOURCE_PRECONDITION_FAILED' });
      expect(update).not.toHaveBeenCalled();
      expect(fence).toHaveBeenCalledTimes(1);
      await sdkUpdate(parentId, before.parent);
      await client.sync();
      const amendmentResult = await connector.amendEvidenceTransaction(
        { expected: before, transaction: amendment },
        authority,
      );
      expect(
        amendmentResult,
        JSON.stringify({
          result: amendmentResult,
          before: before.parent,
          after: (
            await connector.captureEvidenceTransaction({
              budgetId: seeded.budgetId,
              accountId: seeded.accountId,
              transactionId: parentId,
            })
          ).parent,
        }),
      ).toMatchObject({ success: true, verified: true });
      expect(update).toHaveBeenCalledTimes(1);
      const after = await connector.captureEvidenceTransaction({
        budgetId: seeded.budgetId,
        accountId: seeded.accountId,
        transactionId: parentId,
      });
      for (const field of [
        'id',
        'account',
        'date',
        'amount',
        'payee',
        'notes',
        'imported_id',
        'imported_payee',
        'cleared',
        'reconciled',
      ])
        expect(after.parent[field], field).toEqual(before.parent[field]);
      expect(after.children).toHaveLength(2);
      expect(new Set(after.children.map((child) => child.id)).size).toBe(2);
      expect(
        await connector.verifyEvidenceAmendment({ expected: before, transaction: amendment }),
      ).toBe(true);
      // SDK existing-parent updates cannot preserve null child payees under a named parent.
      const reclassify = {
        ...amendment,
        splits: amendment.splits!.map((split) => ({
          ...split,
          categoryId: seeded.otherCategoryId,
        })),
      };
      expect(
        await connector.amendEvidenceTransaction(
          { expected: after, transaction: reclassify },
          authority,
        ),
      ).toMatchObject({ success: false, code: 'INVALID_INPUT' });
      expect(update).toHaveBeenCalledTimes(1);
      expect(
        (
          await connector.captureEvidenceTransaction({
            budgetId: seeded.budgetId,
            accountId: seeded.accountId,
            transactionId: parentId,
          })
        ).fingerprint,
      ).toBe(after.fingerprint);
      const oneBefore = await connector.captureEvidenceTransaction({
        budgetId: seeded.budgetId,
        accountId: seeded.accountId,
        transactionId: oneChildParentId,
      });
      const one: ManualTransactionInput = {
        ...amendment,
        parentId: oneChildParentId,
        correlationId: randomUUID(),
        notes: 'Synthetic one-child settlement note',
        splits: [
          {
            accountId: seeded.accountId,
            date: seeded.date,
            amount: -12500,
            categoryId: seeded.otherCategoryId,
          },
        ],
      };
      const oneResult = await connector.amendEvidenceTransaction(
        { expected: oneBefore, transaction: one },
        authority,
      );
      expect(oneResult, JSON.stringify(oneResult)).toMatchObject({ success: true, verified: true });
      const oneAfter = await connector.captureEvidenceTransaction({
        budgetId: seeded.budgetId,
        accountId: seeded.accountId,
        transactionId: oneChildParentId,
      });
      expect(oneAfter.children).toHaveLength(1);
      expect(oneAfter.children[0]).toMatchObject({
        id: oneChildId,
        amount: -12500,
        category: seeded.otherCategoryId,
        notes: 'Synthetic child note',
      });
      for (const field of [
        'payee',
        'notes',
        'imported_id',
        'imported_payee',
        'cleared',
        'reconciled',
      ])
        expect(oneAfter.parent[field], field).toEqual(oneBefore.parent[field]);
      expect(
        await connector.verifyEvidenceAmendment({ expected: oneBefore, transaction: one }),
      ).toBe(true);
      const uncertain = {
        ...one,
        correlationId: randomUUID(),
        splits: [{ ...one.splits![0]!, categoryId: seeded.categoryId }],
      };
      const dispatches = update.mock.calls.length;
      update.mockImplementationOnce(async (id, fields) => {
        await sdkUpdate(id, fields);
        throw new Error('Synthetic acknowledgement loss after committed SDK write');
      });
      expect(
        await connector.amendEvidenceTransaction(
          { expected: oneAfter, transaction: uncertain },
          authority,
        ),
      ).toMatchObject({ success: false, code: 'WRITE_UNCERTAIN', reviewRequired: true });
      expect(update).toHaveBeenCalledTimes(dispatches + 1);
      expect(
        await connector.verifyEvidenceAmendment({ expected: oneAfter, transaction: uncertain }),
      ).toBe(true);
      expect(update).toHaveBeenCalledTimes(dispatches + 1);
      const aggregateBefore = await connector.captureEvidenceTransaction({
        budgetId: seeded.budgetId,
        accountId: seeded.accountId,
        transactionId: aggregateParentId,
      });
      expect(aggregateBefore.parent).toMatchObject({
        id: aggregateParentId,
        account: seeded.accountId,
        date: seeded.date,
        amount: -1200,
        notes: 'Synthetic aggregate settlement note',
        imported_id: `${marker}-aggregate-bank`,
        imported_payee: 'Synthetic aggregate imported payee',
        cleared: true,
        reconciled: false,
      });
      expect(aggregateBefore.children).toEqual([]);
      const allocationInput = DeriveEvidenceSettlementPlanRequestSchema.parse(
        JSON.parse(
          readFileSync(
            new URL('../../protocol/fixtures/evidence-settlement-plan.json', import.meta.url),
            'utf8',
          ),
        ),
      );
      const target = allocationInput.evidence.observations.find(
        (observation) => observation.kind === 'ledger_transaction',
      )!;
      const oldTargetId = target.id,
        oldDocumentId = target.provenance.documentId;
      target.id = `actual:${aggregateParentId}`;
      target.ledgerTransactionId = aggregateParentId;
      target.ledgerAccountId = seeded.accountId;
      target.date = seeded.date;
      target.provenance = {
        documentId: `sdk-source:${aggregateParentId}`,
        contentHash: aggregateBefore.fingerprint,
        parserVersion: 'actual-sdk-fixture-v1',
        sourceTimestamp: `${seeded.date}T12:00:00Z`,
        receivedAt: `${seeded.date}T12:01:00Z`,
      };
      allocationInput.targetObservationId = target.id;
      for (const observation of allocationInput.evidence.observations)
        observation.date = seeded.date;
      for (const edge of allocationInput.evidence.relationships) {
        if (edge.toId === oldTargetId) edge.toId = target.id;
        edge.evidenceIds = edge.evidenceIds.map((id) =>
          id === oldDocumentId ? target.provenance.documentId : id,
        );
      }
      for (const receipt of allocationInput.evidence.receipts)
        for (const tender of receipt.tenders)
          if (tender.observationId === oldTargetId) tender.observationId = target.id;
      allocationInput.lineCategories = allocationInput.lineCategories.map((choice) => ({
        ...choice,
        categoryId: choice.categoryId === 'food' ? seeded.categoryId : seeded.otherCategoryId,
      }));
      const native = createRequire(import.meta.url)('@balanceframe/native') as {
        deriveEvidenceSettlementPlan(input: string): string;
      };
      const allocation = EvidenceSettlementPlanSchema.parse(
        JSON.parse(native.deriveEvidenceSettlementPlan(JSON.stringify(allocationInput))),
      );
      expect(allocation.ledgerTransactionId).toBe(aggregateParentId);
      expect(allocation.ledgerEffect.amount).toEqual({ minorUnits: '-1200', currency: 'USD' });
      expect(allocation.ledgerEffect.splits).toEqual(
        [
          { categoryId: seeded.categoryId, amount: { minorUnits: '-400', currency: 'USD' } },
          { categoryId: seeded.otherCategoryId, amount: { minorUnits: '-800', currency: 'USD' } },
        ].sort((left, right) => left.categoryId.localeCompare(right.categoryId)),
      );
      const sdkAmount = (minorUnits: string) => {
        const amount = Number(minorUnits);
        expect(Number.isSafeInteger(amount)).toBe(true);
        return amount;
      };
      const aggregateAmendment: ManualTransactionInput = {
        parentId: aggregateParentId,
        correlationId: randomUUID(),
        accountId: allocation.ledgerEffect.accountId,
        date: allocation.ledgerEffect.date,
        amount: sdkAmount(allocation.ledgerEffect.amount.minorUnits),
        categoryId: allocation.ledgerEffect.categoryId,
        payeeName: seeded.payeeName,
        notes: 'Synthetic aggregate settlement note',
        splits: allocation.ledgerEffect.splits.map((split) => ({
          accountId: allocation.ledgerEffect.accountId,
          date: allocation.ledgerEffect.date,
          amount: sdkAmount(split.amount.minorUnits),
          categoryId: split.categoryId,
        })),
      };
      const accountBalance = await client.getAccountBalance(seeded.accountId);
      const parentIds = (await client.getTransactions(seeded.accountId, '0001-01-01', '9999-12-31'))
        .filter((row) => !row.is_child)
        .map((row) => row.id)
        .sort();
      const additions = add.mock.calls.length,
        updates = update.mock.calls.length,
        fences = fence.mock.calls.length;
      const aggregateResult = await connector.amendEvidenceTransaction(
        { expected: aggregateBefore, transaction: aggregateAmendment },
        authority,
      );
      expect(aggregateResult, JSON.stringify(aggregateResult)).toMatchObject({
        success: true,
        verified: true,
      });
      expect(add).toHaveBeenCalledTimes(additions);
      expect(update).toHaveBeenCalledTimes(updates + 1);
      expect(fence).toHaveBeenCalledTimes(fences + 1);
      const aggregateAfter = await connector.captureEvidenceTransaction({
        budgetId: seeded.budgetId,
        accountId: seeded.accountId,
        transactionId: aggregateParentId,
      });
      expect(
        (await client.getTransactions(seeded.accountId, '0001-01-01', '9999-12-31'))
          .filter((row) => !row.is_child)
          .map((row) => row.id)
          .sort(),
      ).toEqual(parentIds);
      expect(await client.getAccountBalance(seeded.accountId)).toBe(accountBalance);
      for (const field of [
        'id',
        'account',
        'date',
        'amount',
        'payee',
        'notes',
        'imported_id',
        'imported_payee',
        'cleared',
        'reconciled',
        'parent_id',
        'is_child',
      ])
        expect(aggregateAfter.parent[field], field).toEqual(aggregateBefore.parent[field]);
      expect(aggregateAfter.children).toHaveLength(2);
      expect(
        aggregateAfter.children.map((child) => ({
          amount: child.amount,
          category: child.category,
        })),
      ).toEqual(
        allocation.ledgerEffect.splits.map((split) => ({
          amount: sdkAmount(split.amount.minorUnits),
          category: split.categoryId,
        })),
      );
      expect(new Set(aggregateAfter.children.map((child) => child.id)).size).toBe(2);
      for (const child of aggregateAfter.children)
        expect(child).toMatchObject({
          parent_id: aggregateParentId,
          account: seeded.accountId,
          date: seeded.date,
          is_child: true,
          is_parent: false,
          cleared: true,
          reconciled: false,
        });
      expect(
        await connector.verifyEvidenceAmendment({
          expected: aggregateBefore,
          transaction: aggregateAmendment,
        }),
      ).toBe(true);
      expect(
        (
          await connector.captureEvidenceTransaction({
            budgetId: seeded.budgetId,
            accountId: seeded.accountId,
            transactionId: aggregateParentId,
          })
        ).children.map((child) => child.id),
      ).toEqual(aggregateAfter.children.map((child) => child.id));
    } finally {
      try {
        await connector?.disconnect();
      } finally {
        try {
          if (created && seedConfig) {
            const budget: SeededBudget = created;
            const config: ClientConfig = seedConfig;
            await withActualClient(
              async () => {
                await deleteBudget(budget.groupId, budget.budgetId);
                expect((await getBudgets()).some((item) => item.name === budget.budgetName)).toBe(
                  false,
                );
              },
              { ...config, dataDir: join(directory, 'cleanup') },
            );
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }
  }, 120000);
});

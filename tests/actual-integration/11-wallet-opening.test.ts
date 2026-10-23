import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ActualConnector,
  NullCredentialStore,
  createDefaultActualClient,
} from '@balanceframe/actual-adapter';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';
import { populateActualBudget } from '../../packages/scenario-kit/src/actual-seed.js';
import { getBudgets, deleteBudget } from './actual-client.js';
import { assertFixtureProvenance, createTestBudget, withActualClient } from './helpers.js';
import type { ClientConfig, SeededBudget } from './helpers.js';

describe('11 — real SDK native wallet opening equity', () => {
  it('preserves native equity markers and historical date, with readonly lost-ack recovery and no duplicate account', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'balanceframe-wallet-opening-sdk-'));
    mkdirSync(join(directory, 'seed'));
    mkdirSync(join(directory, 'cleanup'));
    let created: SeededBudget | null = null,
      seedConfig: ClientConfig | null = null,
      connector: ActualConnector | null = null;
    try {
      const seeded = await withActualClient(
        async (config) => {
          seedConfig = config;
          expect(config.serverURL).toBe(assertFixtureProvenance().serverURL);
          const budget = await createTestBudget(`BalanceFrame-Wallet-Opening-Only-${randomUUID()}`);
          created = budget;
          const source = JSON.parse(
            readFileSync(
              new URL('../../protocol/fixtures/representative.json', import.meta.url),
              'utf8',
            ),
          ) as ProtocolSnapshot;
          await populateActualBudget(source);
          const remote = (await getBudgets()).find(
            (item) => item.name === budget.budgetName && item.groupId === budget.groupId,
          )!;
          return { config, budgetId: remote.cloudFileId ?? remote.id! };
        },
        { dataDir: join(directory, 'seed') },
      );
      const client = await createDefaultActualClient();
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
      const beforeAccounts = await client.getAccounts(),
        fence = vi.fn();
      const input = {
        walletId: `wallet-${randomUUID()}`,
        accountName: `Synthetic opening ${randomUUID()}`,
        currency: 'USD',
        opening: { amount: 1200, date: '2026-09-01' },
      };
      const result = await connector.createWalletAccount(input, {
        budgetId: seeded.budgetId,
        assertExecutionCurrent: fence,
      });
      expect(result).toMatchObject({
        success: true,
        verified: true,
        openingEquity: {
          date: '2026-09-01',
          amount: { minorUnits: '1200', currency: 'USD' },
          startingBalance: true,
        },
      });
      if (!result.success || !result.openingEquity)
        throw new Error('Synthetic opening was not verified');
      expect(fence).toHaveBeenCalledTimes(2);
      expect(await client.getAccountBalance(result.accountId)).toBe(1200);
      const rows = await client.getTransactions(result.accountId, '0001-01-01', '9999-12-31');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: result.openingEquity.transactionId,
        account: result.accountId,
        date: '2026-09-01',
        amount: 1200,
        starting_balance_flag: true,
        cleared: true,
        reconciled: false,
      });
      expect(await connector.readWalletOpeningEquity(input, result.accountId)).toEqual(
        result.openingEquity,
      );
      expect((await client.getAccounts()).length).toBe(beforeAccounts.length + 1);
      expect(
        await connector.createWalletAccount(input, {
          budgetId: seeded.budgetId,
          assertExecutionCurrent: fence,
        }),
      ).toMatchObject({ success: false, code: 'PRECONDITION_MISMATCH' });
      const sdkUpdate = client.updateTransaction.bind(client);
      const update = vi
        .spyOn(client, 'updateTransaction')
        .mockImplementationOnce(async (id, fields) => {
          await sdkUpdate(id, fields);
          throw new Error('synthetic lost date acknowledgement');
        });
      const uncertainInput = {
        ...input,
        walletId: `wallet-${randomUUID()}`,
        accountName: `Synthetic uncertain ${randomUUID()}`,
        opening: { amount: 800, date: '2026-09-02' },
      };
      const uncertain = await connector.createWalletAccount(uncertainInput, {
        budgetId: seeded.budgetId,
        assertExecutionCurrent: vi.fn(),
      });
      expect(uncertain).toMatchObject({
        success: false,
        code: 'WRITE_UNCERTAIN',
        createdAccount: { verified: true },
        openingExpected: { date: '2026-09-02' },
      });
      if (uncertain.success || !uncertain.createdAccount || !uncertain.openingExpected)
        throw new Error('Expected exact uncertain account proof');
      expect(
        await connector.readWalletOpeningEquity(uncertainInput, uncertain.createdAccount.accountId),
      ).toEqual(uncertain.openingExpected);
      expect(update).toHaveBeenCalledTimes(1);
      await sdkUpdate(uncertain.openingExpected.transactionId, {
        notes: 'Synthetic external modification',
      });
      expect(
        (
          await connector.readWalletOpeningEquity(
            uncertainInput,
            uncertain.createdAccount.accountId,
          )
        ).sdkFingerprint,
      ).not.toBe(uncertain.openingExpected.sdkFingerprint);
      expect((await client.getAccounts()).length).toBe(beforeAccounts.length + 2);
    } finally {
      try {
        await connector?.disconnect();
      } finally {
        try {
          if (created && seedConfig) {
            const budget: SeededBudget = created,
              config: ClientConfig = seedConfig;
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

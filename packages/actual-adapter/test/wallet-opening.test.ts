import { describe, expect, it, vi } from 'vitest';
import type { ActualClient } from '../src/connector.js';
import { createWalletWithOpening, readWalletOpeningEquity } from '../src/wallet-opening.js';
import type { TransactionEntity } from '@actual-app/core/types/models';
function setup() {
  const rows: Record<string, unknown>[] = [];
  const accounts: Array<{ id: string; name: string; offbudget: boolean; closed: boolean }> = [];
  let balance = 0;
  const client: Pick<
    ActualClient,
    | 'sync'
    | 'getAccounts'
    | 'getAccountBalance'
    | 'getTransactions'
    | 'createAccount'
    | 'updateTransaction'
  > = {
    sync: vi.fn(async () => {}),
    getAccounts: vi.fn(async () => accounts.map((account) => ({ ...account }))),
    getAccountBalance: vi.fn(async () => balance),
    getTransactions: vi.fn(
      async () => rows.map((row) => ({ ...row })) as unknown as TransactionEntity[],
    ),
    createAccount: vi.fn(async (account, initialBalance) => {
      accounts.push({ id: 'new-account', name: account.name, offbudget: false, closed: false });
      balance = initialBalance ?? 0;
      rows.push({
        id: 'opening-row',
        account: 'new-account',
        date: '2026-10-21',
        amount: initialBalance,
        payee: 'starting-payee',
        category: 'starting-category',
        cleared: true,
        reconciled: false,
        starting_balance_flag: true,
        is_parent: false,
        is_child: false,
        parent_id: null,
        notes: null,
        imported_id: null,
        imported_payee: null,
      });
      return 'new-account';
    }),
    updateTransaction: vi.fn(async (id, fields) => {
      Object.assign(
        rows.find((row) => row.id === id)!,
        fields,
      );
    }),
  };
  const input = {
    walletId: 'wallet',
    accountName: 'Wallet',
    currency: 'USD',
    opening: { amount: 1200, date: '2026-10-15' },
  };
  const authority = { budgetId: 'budget', assertExecutionCurrent: vi.fn() };
  const run = () => createWalletWithOpening(client, input, authority, () => {});
  return { client, input, authority, rows, accounts, run };
}
describe('native Actual opening equity writer', () => {
  it('preserves the SDK equity row while changing only its date under two execution fences', async () => {
    const fixture = setup();
    const result = await fixture.run();
    expect(result).toMatchObject({
      success: true,
      verified: true,
      walletId: 'wallet',
      accountId: 'new-account',
      openingEquity: {
        transactionId: 'opening-row',
        date: '2026-10-15',
        amount: { minorUnits: '1200', currency: 'USD' },
        startingBalance: true,
      },
    });
    expect(fixture.client.createAccount).toHaveBeenCalledWith(
      { name: 'Wallet', offbudget: false, closed: false },
      1200,
    );
    expect(fixture.client.updateTransaction).toHaveBeenCalledWith('opening-row', {
      date: '2026-10-15',
    });
    expect(fixture.authority.assertExecutionCurrent).toHaveBeenCalledTimes(2);
    expect(fixture.rows[0]).toMatchObject({
      payee: 'starting-payee',
      category: 'starting-category',
      starting_balance_flag: true,
      cleared: true,
      amount: 1200,
    });
    const read = await readWalletOpeningEquity(fixture.client, fixture.input, 'new-account');
    expect(read).toEqual(result.success ? result.openingEquity : undefined);
  });
  it('refuses invalid amounts/dates and existing names without dispatching', async () => {
    for (const opening of [
      { amount: 0, date: '2026-10-15' },
      { amount: -1, date: '2026-10-15' },
      { amount: 1.1, date: '2026-10-15' },
      { amount: Number.MAX_SAFE_INTEGER + 1, date: '2026-10-15' },
      { amount: 1200, date: '2026-02-30' },
    ]) {
      const fixture = setup();
      fixture.input.opening = opening;
      expect(await fixture.run()).toMatchObject({ success: false, code: 'INVALID_INPUT' });
      expect(fixture.client.createAccount).not.toHaveBeenCalled();
    }
    const fixture = setup();
    fixture.accounts.push({ id: 'old', name: 'Wallet', offbudget: false, closed: false });
    expect(await fixture.run()).toMatchObject({ success: false, code: 'PRECONDITION_MISMATCH' });
    expect(fixture.client.createAccount).not.toHaveBeenCalled();
  });
  it('does not adjust after lost creation acknowledgement or a revoked second fence', async () => {
    const fixture = setup();
    const create = fixture.client.createAccount;
    vi.mocked(fixture.client.createAccount).mockImplementationOnce(async (...args) => {
      await create(...args);
      throw new Error('lost creation acknowledgement');
    });
    expect(await fixture.run()).toMatchObject({ success: false, code: 'WRITE_UNCERTAIN' });
    expect(fixture.client.updateTransaction).not.toHaveBeenCalled();
    const second = setup();
    second.authority.assertExecutionCurrent
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('revoked');
      });
    expect(await second.run()).toMatchObject({
      success: false,
      code: 'WRITE_UNCERTAIN',
      createdAccount: { walletId: 'wallet', accountId: 'new-account', verified: true },
    });
    expect(second.client.updateTransaction).not.toHaveBeenCalled();
  });
  it('recovers committed date acknowledgement loss by readonly exact proof and refuses ordinary or changed rows', async () => {
    const fixture = setup();
    vi.mocked(fixture.client.updateTransaction).mockImplementationOnce(async (id, fields) => {
      Object.assign(
        fixture.rows.find((row) => row.id === id)!,
        fields,
      );
      throw new Error('lost date acknowledgement');
    });
    const result = await fixture.run();
    expect(result).toMatchObject({
      success: false,
      code: 'WRITE_UNCERTAIN',
      createdAccount: { verified: true },
      openingExpected: { transactionId: 'opening-row' },
    });
    if (result.success || !result.openingExpected)
      throw new Error('Expected uncertain opening proof');
    const current = await readWalletOpeningEquity(fixture.client, fixture.input, 'new-account');
    expect(current.sdkFingerprint).toBe(result.openingExpected.sdkFingerprint);
    expect(fixture.client.updateTransaction).toHaveBeenCalledTimes(1);
    fixture.rows[0]!.starting_balance_flag = false;
    await expect(
      readWalletOpeningEquity(fixture.client, fixture.input, 'new-account'),
    ).rejects.toThrow(/equity/);
    fixture.rows[0]!.starting_balance_flag = true;
    fixture.rows.push({ ...fixture.rows[0], id: 'unrelated' });
    await expect(
      readWalletOpeningEquity(fixture.client, fixture.input, 'new-account'),
    ).rejects.toThrow(/equity/);
  });
});

import { createHash } from 'node:crypto';
import type { ActualClient } from './connector.js';
import type {
  WalletAccountInput,
  WalletAccountPrecondition,
  WalletAccountResult,
  WalletOpeningEquity,
} from './types.js';

type Client = Pick<
  ActualClient,
  | 'sync'
  | 'getAccounts'
  | 'getAccountBalance'
  | 'getTransactions'
  | 'createAccount'
  | 'updateTransaction'
>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function dateValid(date: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    date >= '0001-01-01' &&
    date <= '9999-12-31' &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
  );
}
function valid(input: WalletAccountInput): boolean {
  return (
    !!input.walletId.trim() &&
    !!input.accountName.trim() &&
    /^[A-Z]{3}$/.test(input.currency) &&
    !!input.opening &&
    Number.isSafeInteger(input.opening.amount) &&
    input.opening.amount > 0 &&
    dateValid(input.opening.date)
  );
}
async function read(
  client: Client,
  input: WalletAccountInput,
  accountId: string,
  expectedDate: string,
) {
  await client.sync();
  const [accounts, balance, rows] = await Promise.all([
    client.getAccounts(),
    client.getAccountBalance(accountId),
    client.getTransactions(accountId, '0001-01-01', '9999-12-31'),
  ]);
  const account = accounts.filter((a) => a.id === accountId);
  const row = rows[0] as unknown as Record<string, unknown> | undefined;
  if (
    account.length !== 1 ||
    account[0]!.name !== input.accountName ||
    account[0]!.offbudget ||
    account[0]!.closed ||
    balance !== input.opening?.amount ||
    rows.length !== 1 ||
    !row ||
    typeof row.id !== 'string' ||
    !row.id ||
    row.account !== accountId ||
    row.amount !== input.opening.amount ||
    row.date !== expectedDate ||
    row.starting_balance_flag !== true ||
    row.cleared !== true ||
    row.reconciled === true ||
    row.is_parent === true ||
    row.is_child === true ||
    row.parent_id != null ||
    row.transfer_id != null ||
    row.tombstone ||
    row.error ||
    (Array.isArray(row.subtransactions) && row.subtransactions.length) ||
    typeof row.payee !== 'string' ||
    !row.payee ||
    (row.category != null && typeof row.category !== 'string')
  )
    throw new Error('Native opening equity readback is missing, ambiguous, or changed');
  return { account: account[0]!, row, balance };
}
function proof(
  input: WalletAccountInput,
  accountId: string,
  source: Awaited<ReturnType<typeof read>>,
  date: string,
): WalletOpeningEquity {
  const row: Record<string, unknown> = { ...source.row, date };
  return {
    walletId: input.walletId,
    accountId,
    transactionId: row.id as string,
    date,
    amount: { minorUnits: String(input.opening!.amount), currency: input.currency },
    startingBalance: true,
    sdkFingerprint: createHash('sha256')
      .update(
        canonical({
          account: source.account,
          row,
          balance: source.balance,
          walletId: input.walletId,
          currency: input.currency,
        }),
      )
      .digest('hex'),
    payeeId: row.payee as string,
    categoryId: (row.category as string | null) ?? null,
  };
}
export async function readWalletOpeningEquity(
  client: Client,
  input: WalletAccountInput,
  accountId: string,
): Promise<WalletOpeningEquity> {
  if (!valid(input)) throw new Error('Invalid opening equity input');
  return proof(
    input,
    accountId,
    await read(client, input, accountId, input.opening!.date),
    input.opening!.date,
  );
}
/** Called only inside the connector's selected-budget cache lock and governed execution fence. */
export async function createWalletWithOpening(
  client: Client,
  input: WalletAccountInput,
  authority: WalletAccountPrecondition,
  assertSelected: () => void,
): Promise<WalletAccountResult> {
  if (!valid(input))
    return {
      success: false,
      code: 'INVALID_INPUT',
      error: 'Positive safe opening amount and canonical date are required.',
    };
  let existing: Awaited<ReturnType<Client['getAccounts']>>;
  try {
    assertSelected();
    await client.sync();
    existing = await client.getAccounts();
  } catch {
    return {
      success: false,
      code: 'PRECONDITION_READ_FAILED',
      error: 'Unable to read current wallet accounts.',
    };
  }
  if (existing.some((a) => a.name === input.accountName))
    return {
      success: false,
      code: 'PRECONDITION_MISMATCH',
      error: 'Wallet account name already exists.',
    };
  let accountId: string;
  try {
    assertSelected();
    authority.assertExecutionCurrent();
  } catch {
    return {
      success: false,
      code: 'PRECONDITION_MISMATCH',
      error: 'Wallet execution authority changed.',
    };
  }
  try {
    accountId = await client.createAccount(
      { name: input.accountName, offbudget: false, closed: false },
      input.opening!.amount,
    );
  } catch {
    return {
      success: false,
      code: 'WRITE_UNCERTAIN',
      error: 'Native wallet creation acknowledgement is uncertain.',
      reviewRequired: true,
    };
  }
  let createdAccount: { walletId: string; accountId: string; verified: true } | undefined;
  let openingExpected: WalletOpeningEquity | undefined;
  try {
    if (!accountId || existing.some((a) => a.id === accountId))
      throw new Error('Invalid generated account identity');
    await client.sync();
    const accounts = await client.getAccounts();
    const account = accounts.filter((a) => a.id === accountId);
    if (
      account.length !== 1 ||
      account[0]!.name !== input.accountName ||
      account[0]!.offbudget ||
      account[0]!.closed
    )
      throw new Error('Generated account identity could not be verified');
    createdAccount = { walletId: input.walletId, accountId, verified: true };
    const rows = await client.getTransactions(accountId, '0001-01-01', '9999-12-31');
    const generatedDate = rows[0]?.date;
    if (typeof generatedDate !== 'string' || !dateValid(generatedDate))
      throw new Error('Invalid generated opening date');
    const before = await read(client, input, accountId, generatedDate);
    openingExpected = proof(input, accountId, before, input.opening!.date);
    if (generatedDate !== input.opening!.date) {
      // Re-read the entire SDK row immediately before the second independently fenced mutation.
      const current = await read(client, input, accountId, generatedDate);
      if (canonical(current) !== canonical(before))
        throw new Error('Opening equity changed before date adjustment');
      assertSelected();
      authority.assertExecutionCurrent();
      await client.updateTransaction(openingExpected.transactionId, { date: input.opening!.date });
    }
    const current = await readWalletOpeningEquity(client, input, accountId);
    assertSelected();
    if (current.sdkFingerprint !== openingExpected.sdkFingerprint)
      throw new Error('Opening equity metadata changed');
    return {
      success: true,
      walletId: input.walletId,
      accountId,
      verified: true,
      openingEquity: current,
    };
  } catch {
    return {
      success: false,
      code: 'WRITE_UNCERTAIN',
      error: 'Wallet creation or native equity date adjustment requires readonly recovery.',
      reviewRequired: true,
      ...(createdAccount ? { createdAccount } : {}),
      ...(openingExpected ? { openingExpected } : {}),
    };
  }
}

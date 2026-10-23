import { describe, expect, it } from 'vitest';
import {
  bindWalletOpening,
  walletAnchorEvidence,
  verifiedWalletAccount,
} from '../src/wallet-opening.js';
const opening = {
  amount: { minorUnits: '1200', currency: 'USD' },
  date: '2026-09-01',
  proofSetHash: 'a'.repeat(64),
  activityManifestHash: 'b'.repeat(64),
};
const action = {
  kind: 'wallet_materialization' as const,
  walletId: 'wallet',
  accountName: 'Wallet',
  currency: 'USD',
  opening,
};
const anchor = {
  kind: 'wallet_statement_anchor' as const,
  scope: { kind: 'claim' as const, id: 'wallet' },
  state: 'resolved' as const,
  observedAt: '2026-09-06T00:00:00Z',
  contentHash: opening.proofSetHash,
  version: 'wallet-statement-v1',
  walletBalanceAnchor: {
    walletId: 'wallet',
    amount: opening.amount,
    asOfDate: opening.date,
    boundary: 'before_day_activity' as const,
    proofSetHash: opening.proofSetHash,
    activityManifestHash: opening.activityManifestHash,
    proofIds: ['proof'],
    evidenceIds: ['document'],
  },
  evidence: [
    {
      evidenceId: 'document',
      kind: 'human_attested_statement',
      authorized: true,
      redaction: 'visible' as const,
    },
  ],
};
describe('governed wallet opening authority', () => {
  it('binds only a unique current authorized before-day native anchor', () => {
    expect(bindWalletOpening(action, [anchor], () => true)).toEqual(action);
    expect(walletAnchorEvidence(anchor, () => true)).toEqual([
      {
        evidenceId: 'document',
        subjectId: 'wallet',
        state: 'resolved',
        contentHash: opening.proofSetHash,
        version: 'wallet-statement-v1',
      },
    ]);
    for (const changed of [
      { ...anchor, state: 'unknown' as const },
      {
        ...anchor,
        walletBalanceAnchor: {
          ...anchor.walletBalanceAnchor,
          boundary: 'after_day_activity' as const,
        },
      },
      {
        ...anchor,
        walletBalanceAnchor: {
          ...anchor.walletBalanceAnchor,
          amount: { minorUnits: '1201', currency: 'USD' },
        },
      },
    ])
      expect(() => bindWalletOpening(action, [changed], () => true)).toThrow();
    expect(bindWalletOpening(action, [anchor, anchor], () => true)).toEqual(action);
    expect(() => bindWalletOpening(action, [anchor], () => false)).toThrow();
    expect(walletAnchorEvidence(anchor, () => false)).toEqual([]);
  });
  it('reserves a verified account even when its opening outcome is uncertain and ignores unverified identities', () => {
    expect(
      verifiedWalletAccount(action, {
        success: false,
        createdAccount: { walletId: 'wallet', accountId: 'generated', verified: true },
      }),
    ).toBe('generated');
    expect(
      verifiedWalletAccount(action, {
        success: true,
        walletId: 'wallet',
        accountId: 'generated',
        verified: true,
      }),
    ).toBe('generated');
    for (const result of [
      {
        success: false,
        createdAccount: { walletId: 'other', accountId: 'generated', verified: true },
      },
      {
        success: false,
        createdAccount: { walletId: 'wallet', accountId: 'generated', verified: false },
      },
      { success: false, accountId: 'generated' },
      { success: true, walletId: 'wallet', accountId: 'generated', verified: false },
    ])
      expect(verifiedWalletAccount(action, result)).toBeNull();
  });
});

it('selects the exact before-day anchor from real native statement coverage with both boundary proofs', async () => {
  const { createRequire } = await import('node:module');
  const { readFileSync } = await import('node:fs');
  const native = createRequire(import.meta.url)('@balanceframe/native') as {
    resolveTransactionEvidence(input: string): string;
  };
  const input = readFileSync(
    new URL('../../../protocol/fixtures/wallet-statement.json', import.meta.url),
    'utf8',
  );
  const resolution = JSON.parse(native.resolveTransactionEvidence(input));
  const wallet = resolution.wallets[0];
  expect(wallet.anchorObservations).toHaveLength(2);
  const value = wallet.balanceAnchors.find(
    (a: { boundary: string }) => a.boundary === 'before_day_activity',
  );
  const intent = {
    kind: 'wallet_materialization' as const,
    walletId: wallet.walletId,
    accountName: 'Reviewed wallet',
    currency: value.amount.currency,
    opening: {
      amount: value.amount,
      date: value.asOfDate,
      proofSetHash: value.proofSetHash,
      activityManifestHash: value.activityManifestHash,
    },
  };
  expect(bindWalletOpening(intent, wallet.anchorObservations, () => true)).toEqual(intent);
  expect(
    bindWalletOpening(
      intent,
      [...wallet.anchorObservations, wallet.anchorObservations[0]],
      () => true,
    ),
  ).toEqual(intent);
});

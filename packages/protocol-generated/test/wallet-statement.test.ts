import { describe, expect, it } from 'vitest';
import { WalletStatementProofSchema, WalletStatementBalanceAnchorSchema } from '../src/validators';
const proof = {
  proofId: 'proof',
  authorityKind: 'human_attested_statement',
  statement: { documentId: 'doc', contentHash: 'a'.repeat(64), parserVersion: '1' },
  walletId: 'wallet',
  currency: 'USD',
  calendarBasis: 'statement_printed_date',
  startDate: '2026-10-01',
  endDate: '2026-10-02',
  openingBalance: { minorUnits: '0', currency: 'USD' },
  closingBalance: null,
  activityManifest: [],
  actorId: 'actor',
  membershipId: 'member',
  policyVersion: '1',
  reviewedAt: '2026-10-03T00:00:00Z',
};
describe('human-attested wallet statement contracts', () => {
  it('accepts empty activity and either explicit boundary', () => {
    expect(WalletStatementProofSchema.parse(proof)).toEqual(proof);
    expect(
      WalletStatementProofSchema.safeParse({
        ...proof,
        openingBalance: null,
        closingBalance: proof.openingBalance,
      }).success,
    ).toBe(true);
  });
  it('rejects absent boundaries, impossible dates, invalid identity, authority and money', () => {
    for (const change of [
      { openingBalance: null },
      { endDate: '2026-02-30' },
      { startDate: '2026-11-01' },
      { authorityKind: 'provider_authenticated' },
      { proofId: 'a\u0000b' },
      { currency: 'usd' },
      { openingBalance: { minorUnits: '-1', currency: 'USD' } },
      { openingBalance: { minorUnits: '9223372036854775808', currency: 'USD' } },
      { openingBalance: { minorUnits: '1', currency: 'EUR' } },
      { extra: true },
      { statement: { ...proof.statement, contentHash: 'A'.repeat(64) } },
      { activityManifest: [{}] },
      { reviewedAt: 'yesterday' },
    ])
      expect(WalletStatementProofSchema.safeParse({ ...proof, ...change }).success).toBe(false);
  });
  it('validates a bounded native balance anchor', () => {
    const anchor = {
      walletId: 'wallet',
      amount: proof.openingBalance,
      asOfDate: proof.startDate,
      boundary: 'before_day_activity',
      proofIds: ['proof'],
      proofSetHash: 'b'.repeat(64),
      activityManifestHash: 'c'.repeat(64),
      evidenceIds: ['doc'],
    };
    expect(WalletStatementBalanceAnchorSchema.safeParse(anchor).success).toBe(true);
    expect(
      WalletStatementBalanceAnchorSchema.safeParse({ ...anchor, boundary: 'any_time' }).success,
    ).toBe(false);
  });
});
it('requires canonical UTC review timestamps and exact native anchor metadata', async () => {
  const { sourceObservationSchema } = await import('../src/validators');
  expect(
    WalletStatementProofSchema.safeParse({ ...proof, reviewedAt: '2026-10-03T00:00:00+00:00' })
      .success,
  ).toBe(false);
  const anchor = {
    walletId: 'wallet',
    amount: proof.openingBalance,
    asOfDate: proof.startDate,
    boundary: 'before_day_activity',
    proofIds: ['proof'],
    proofSetHash: 'b'.repeat(64),
    activityManifestHash: 'c'.repeat(64),
    evidenceIds: ['doc'],
  };
  const observation = {
    kind: 'wallet_statement_anchor',
    scope: { kind: 'claim', id: 'wallet' },
    state: 'resolved',
    observedAt: proof.reviewedAt,
    contentHash: anchor.proofSetHash,
    version: 'wallet-statement-v1',
    walletBalanceAnchor: anchor,
    evidence: [
      {
        evidenceId: 'doc',
        kind: 'human_attested_statement',
        authorized: true,
        redaction: 'visible',
      },
    ],
  };
  expect(sourceObservationSchema.parse(observation)).toEqual(observation);
  for (const change of [
    { version: 'other' },
    { contentHash: 'd'.repeat(64) },
    { walletBalanceAnchor: undefined },
    { scope: { kind: 'account', id: 'wallet' } },
    { state: 'unknown' },
    { observedAt: null },
    { evidence: [] },
    { evidence: [{ ...observation.evidence[0], authorized: false }] },
    { evidence: [{ ...observation.evidence[0], redaction: 'redacted' }] },
    { kind: 'account_balance' },
  ])
    expect(sourceObservationSchema.safeParse({ ...observation, ...change }).success).toBe(false);
});
it('validates canonical native preview and signed checked money boundaries', async () => {
  const { readFileSync } = await import('node:fs');
  const { WalletStatementPreviewSchema, DeriveWalletStatementPreviewRequestSchema } =
    await import('../src/validators');
  const preview = JSON.parse(
    readFileSync(
      new URL('../../../protocol/fixtures/wallet-statement-preview.json', import.meta.url),
      'utf8',
    ),
  );
  const evidence = JSON.parse(
    readFileSync(
      new URL('../../../protocol/fixtures/wallet-statement.json', import.meta.url),
      'utf8',
    ),
  );
  expect(WalletStatementPreviewSchema.parse(preview)).toEqual(preview);
  expect(
    DeriveWalletStatementPreviewRequestSchema.safeParse({
      contractVersion: '1',
      evidence,
      walletId: 'wallet',
      startDate: '2026-10-15',
      endDate: '2026-10-16',
    }).success,
  ).toBe(true);
  for (const minorUnits of ['-9223372036854775808', '9223372036854775807', '0'])
    expect(
      WalletStatementPreviewSchema.safeParse({
        ...preview,
        netChange: { minorUnits, currency: 'USD' },
      }).success,
    ).toBe(true);
  for (const minorUnits of ['-9223372036854775809', '9223372036854775808', '01', '1.0', 'bad'])
    expect(
      WalletStatementPreviewSchema.safeParse({
        ...preview,
        netChange: { minorUnits, currency: 'USD' },
      }).success,
    ).toBe(false);
});

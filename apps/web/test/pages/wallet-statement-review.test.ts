import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import WalletStatementReview from '../../app/components/WalletStatementReview.vue';
import result from '../../../../protocol/fixtures/transaction-evidence-result.json';
const fetcher = vi.fn();
const reauth = vi.hoisted(() => vi.fn());
vi.mock('../../app/utils/reauthentication', () => ({ reauthenticateHuman: reauth }));
const wrappers: VueWrapper[] = [];
const reply = (v: unknown) =>
  new Response(JSON.stringify({ status: 'ok', result: v, error: null }));
const proof = {
  proofId: 'proof',
  authorityKind: 'human_attested_statement',
  statement: { documentId: 'doc', contentHash: 'a'.repeat(64), parserVersion: 'wallet-v1' },
  walletId: 'wallet',
  currency: 'USD',
  calendarBasis: 'statement_printed_date',
  startDate: '2026-10-01',
  endDate: '2026-10-20',
  openingBalance: { minorUnits: '100', currency: 'USD' },
  closingBalance: { minorUnits: '100', currency: 'USD' },
  activityManifest: [],
  actorId: 'owner',
  membershipId: 'period',
  policyVersion: 'policy',
  reviewedAt: '2026-10-21T12:00:00Z',
};
const context = {
  foldHash: 'b'.repeat(64),
  proofs: [proof],
  documents: [
    {
      id: 'doc',
      connectorId: 'wallet',
      sourceId: 'statement',
      contentHash: 'a'.repeat(64),
      parserVersion: 'wallet-v1',
      mediaType: 'application/pdf',
      retentionUntil: '2026-10-22T12:00:00Z',
    },
  ],
  wallets: [],
  resolution: result,
};
const preview = {
  previewHash: 'c'.repeat(64),
  proofFoldHash: context.foldHash,
  proof,
  native: {
    contractVersion: '1',
    walletId: 'wallet',
    currency: 'USD',
    startDate: proof.startDate,
    endDate: proof.endDate,
    activityManifest: [],
    activityManifestHash: 'd'.repeat(64),
    netChange: { minorUnits: '0', currency: 'USD' },
    inflows: { minorUnits: '0', currency: 'USD' },
    outflows: { minorUnits: '0', currency: 'USD' },
    excludedObservationIds: [],
    reasonCodes: [],
  },
  resolution: result,
};
beforeEach(() => {
  fetcher.mockReset();
  reauth.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  vi.unstubAllGlobals();
});
function panel() {
  const w = mount(WalletStatementReview, { props: { sourceVersion: 'sources-1' } });
  wrappers.push(w);
  return w;
}
async function load(w: VueWrapper) {
  fetcher.mockResolvedValueOnce(reply(context));
  await w.get('[data-testid="wallet-proof-load"]').trigger('click');
  await flushPromises();
}
async function fill(w: VueWrapper) {
  await w.get('[data-testid="wallet-proof-document"]').setValue('doc');
  await w.get('[data-testid="wallet-proof-label"]').setValue('My wallet');
  await w.get('[data-testid="wallet-proof-start"]').setValue(proof.startDate);
  await w.get('[data-testid="wallet-proof-end"]').setValue(proof.endDate);
  await w.get('[data-testid="wallet-proof-opening"]').setValue('100');
  await w.get('[data-testid="wallet-proof-closing"]').setValue('100');
}
it('requires delivery of original plus explicit complete-coverage human review and sends no issuer authority', async () => {
  const w = panel();
  expect(fetcher).not.toHaveBeenCalled();
  await load(w);
  await fill(w);
  fetcher.mockResolvedValueOnce(reply(preview));
  await w.get('[data-testid="wallet-proof-preview"]').trigger('click');
  await flushPromises();
  expect(w.text()).toContain('human-attested');
  expect(w.get<HTMLButtonElement>('[data-testid="wallet-proof-attest"]').element.disabled).toBe(
    true,
  );
  fetcher.mockResolvedValueOnce(reply({ contentBase64: btoa('synthetic statement') }));
  await w.get('[data-testid="wallet-proof-original"]').trigger('click');
  await flushPromises();
  expect(w.get('[data-testid="wallet-proof-download"]').attributes('download')).toBe(
    'wallet-statement.bin',
  );
  await w.get('[data-testid="wallet-proof-download"]').trigger('click');
  await w.get('[data-testid="wallet-proof-original-ack"]').setValue(true);
  await w.get('[data-testid="wallet-proof-complete-ack"]').setValue(true);
  await w.get('[data-testid="wallet-proof-password"]').setValue('password');
  fetcher.mockResolvedValueOnce(reply({ proof, ...context }));
  await w.get('[data-testid="wallet-proof-attest"]').trigger('click');
  await flushPromises();
  expect(reauth).toHaveBeenCalledWith('password');
  const body = JSON.parse(fetcher.mock.calls[3]![1].body);
  expect(body).toMatchObject({
    previewHash: preview.previewHash,
    expectedProofFoldHash: context.foldHash,
    originalAcknowledged: true,
    completeActivityAcknowledged: true,
  });
  expect(body).not.toHaveProperty('actorId');
  expect(body).not.toHaveProperty('activityManifest');
  expect(w.emitted('changed')).toBeTruthy();
});
it('revokes without reading expired original and clears pending preview on source change', async () => {
  const w = panel();
  await load(w);
  await w.get('[data-testid="wallet-proof-revoke-confirm"]').setValue(true);
  await w.get('[data-testid="wallet-proof-password"]').setValue('password');
  fetcher.mockResolvedValueOnce(reply({ ...context, proofs: [] }));
  await w.get('[data-testid="wallet-proof-revoke"]').trigger('click');
  await flushPromises();
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
    proofId: 'proof',
    expectedProofFoldHash: context.foldHash,
  });
  expect(fetcher.mock.calls.some((c) => String(c[0]).endsWith('/raw'))).toBe(false);
  await load(w);
  await fill(w);
  let finish!: (r: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await w.get('[data-testid="wallet-proof-preview"]').trigger('click');
  await w.setProps({ sourceVersion: 'sources-2' });
  finish(reply(preview));
  await flushPromises();
  expect(w.find('[data-testid="wallet-proof-attest"]').exists()).toBe(false);
});

it('prepares exact selected opening equity for separate approval without sending an amount', async () => {
  const anchor = {
    walletId: 'wallet',
    amount: { minorUnits: '100', currency: 'USD' },
    asOfDate: '2026-10-01',
    boundary: 'before_day_activity',
    proofIds: ['proof'],
    proofSetHash: 'e'.repeat(64),
    activityManifestHash: 'f'.repeat(64),
    evidenceIds: ['doc'],
  };
  const wallet = {
    walletId: 'wallet',
    openingBalance: anchor.amount,
    closingBalance: anchor.amount,
    balanceState: 'known',
    projection: 'materialize',
    reasonCodes: [],
    balanceAnchors: [anchor, { ...anchor, boundary: 'after_day_activity' }],
  };
  fetcher.mockResolvedValueOnce(
    reply({ ...context, resolution: { ...result, wallets: [wallet] } }),
  );
  const w = panel();
  await w.get('[data-testid="wallet-proof-load"]').trigger('click');
  await flushPromises();
  expect(w.text()).toContain('Opening equity');
  await w.get('[data-testid="wallet-opening-anchor"]').setValue('0');
  await w.get('[data-testid="wallet-opening-name"]').setValue('Reviewed wallet');
  fetcher.mockResolvedValueOnce(reply({ proposalId: 'proposal' }));
  await w.get('[data-testid="wallet-opening-propose"]').trigger('click');
  await flushPromises();
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
    resolutionHash: result.resolutionHash,
    walletId: 'wallet',
    proofSetHash: anchor.proofSetHash,
    activityManifestHash: anchor.activityManifestHash,
    asOfDate: anchor.asOfDate,
    accountName: 'Reviewed wallet',
  });
  expect(reauth).not.toHaveBeenCalled();
  expect(w.get('[data-testid="wallet-opening-proposal"]').attributes('href')).toBe(
    '/proposals/proposal',
  );
  await w.setProps({ sourceVersion: 'changed' });
  expect(w.find('[data-testid="wallet-opening-proposal"]').exists()).toBe(false);
});

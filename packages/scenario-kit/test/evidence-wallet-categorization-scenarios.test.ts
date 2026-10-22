import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvidenceScenarioSetup } from '../src/evidence-scenario-support.js';

const calls = vi.hoisted(() => ({ post: vi.fn(), grant: vi.fn(), get: vi.fn(), put: vi.fn(), reauthenticate: vi.fn() }));
vi.mock('../src/evidence-scenario-support.js', () => ({
  evidenceFixture: (name: string) => JSON.parse(readFileSync(new URL(`../../../protocol/fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown,
  evidenceString: (value: unknown, label: string) => {
    if (typeof value !== 'string' || !value) throw new Error(label);
    return value;
  },
  evidenceResult: (body: { status: string; result: unknown }) => { if (body.status !== 'ok') throw new Error('unsuccessful'); return body.result; },
  evidencePost: calls.post,
  evidenceGrant: calls.grant,
}));
import { initializeWalletCategorizationEvidence } from '../src/evidence-wallet-categorization-scenarios.js';

function context(id: string) {
  return { clients: { owner: { get: calls.get, put: calls.put, reauthenticate: calls.reauthenticate } }, personas: { owner: { spaceId: 'space', password: 'fictional-password' } }, scenario: { id, anchor: '2026-10-22T12:00:00.000Z' }, seeded: { budgetId: 'native-budget', readResources: [{ resourceKind: 'account', resourceId: 'native-checking' }], accountIds: { 'acct-checking': 'native-checking' }, categoryIds: { 'cat-groceries': 'native-food' } } } as unknown as EvidenceScenarioSetup;
}
beforeEach(() => {
  calls.post.mockReset().mockResolvedValue({ document: { id: 'document-1', parseStatus: 'parsed' } });
  calls.grant.mockReset().mockResolvedValue(undefined);
  calls.get.mockReset().mockImplementation(async (path: string) => ({ status: 'ok', result: path.endsWith('/policy') ? { policy: { version: 'policy-1', minimumApprovers: 1, approvalThresholds: [], operationApprovers: {} } } : { wallets: [{ walletId: 'qualified-wallet' }] } }));
  calls.put.mockReset().mockResolvedValue({ status: 'ok', result: {} });
  calls.reauthenticate.mockReset().mockResolvedValue(undefined);
});

describe('canonical wallet and categorization evidence seeds', () => {
  it('does not initialize unrelated scenario families', async () => {
    expect(await initializeWalletCategorizationEvidence(context('funded-purchase'))).toEqual({});
    expect(calls.post).not.toHaveBeenCalled();
    expect(calls.grant).not.toHaveBeenCalled();
  });
  it('imports the canonical wallet activity without an imported proof or a financial write', async () => {
    const ctx = context('evidence-wallet-statement');
    const ids = await initializeWalletCategorizationEvidence(ctx);
    expect(ids).toMatchObject({ walletStatementDocumentId: 'document-1', walletId: 'qualified-wallet' });
    expect(calls.grant).toHaveBeenCalledWith(ctx, 'owner', 'wallet', 'qualified-wallet', ['existence', 'history', 'name', 'full-read', 'wallet_materialization:propose', 'wallet_materialization:execute']);
    expect(calls.grant).toHaveBeenCalledWith(ctx, 'owner', 'evidence', 'document-1', ['full-read']);
    for (const reviewer of ['coapprover', 'approver']) {
      expect(calls.grant).toHaveBeenCalledWith(ctx, reviewer, 'budget', 'native-budget', ['observe', 'source', 'wallet_materialization:approve']);
      expect(calls.grant).toHaveBeenCalledWith(ctx, reviewer, 'account', 'native-checking', ['existence', 'history', 'name', 'source', 'full-read']);
      expect(calls.grant).toHaveBeenCalledWith(ctx, reviewer, 'wallet', 'qualified-wallet', ['existence', 'history', 'name', 'full-read', 'wallet_materialization:approve']);
      expect(calls.grant).toHaveBeenCalledWith(ctx, reviewer, 'evidence', 'document-1', ['evidence', 'normalized-evidence', 'source', 'full-read']);
    }
    for (const [, personaId, kind, , capabilities] of calls.grant.mock.calls)
      if (personaId !== 'owner') {
        expect(capabilities.some((capability: string) => capability.endsWith(':execute'))).toBe(false);
        if (kind === 'budget') expect(capabilities).not.toContain('full-read');
      }
    expect(calls.put).toHaveBeenCalledWith('/api/spaces/space/policy', { expectedVersion: 'policy-1', policy: { minimumApprovers: 2, assistanceMaximum: 'execute_approved_actions', approvalThresholds: [], operationApprovers: {} } });
    expect(calls.put.mock.invocationCallOrder[0]).toBeLessThan(calls.post.mock.invocationCallOrder[0]!);
    const [actualContext, path, input] = calls.post.mock.calls[0]!;
    expect(actualContext).toBe(ctx);
    expect(path).toBe('/api/evidence');
    const extraction = JSON.parse(input.content as string);
    expect(extraction.observations).toMatchObject([{ id: 'wallet-1', amount: { minorUnits: '100', currency: 'USD' }, direction: 'outflow', reliability: 0 }]);
    expect(extraction).not.toHaveProperty('statementProofs');
    expect(extraction.observations[0]).not.toHaveProperty('provenance');
    expect(extraction.wallets[0]).toMatchObject({ openingBalance: { minorUnits: '200', currency: 'USD' }, closingBalance: { minorUnits: '100', currency: 'USD' }, completeActivity: true });
    expect(calls.post).toHaveBeenCalledTimes(1);
    expect(calls.grant).toHaveBeenCalledWith(ctx, 'owner', 'evidence', 'document-1', ['evidence', 'normalized-evidence', 'raw-document', 'resolve', 'source']);
  });
  it('imports two independent receipt sources with hints and preserves exact canonical amounts', async () => {
    const ctx = context('evidence-categorization');
    calls.post.mockResolvedValueOnce({ document: { id: 'receipt-doc-1', parseStatus: 'parsed' } }).mockResolvedValueOnce({ document: { id: 'receipt-doc-2', parseStatus: 'parsed' } });
    const ids = await initializeWalletCategorizationEvidence(ctx);
    expect(ids).toMatchObject({ firstDocumentId: 'receipt-doc-1', secondDocumentId: 'receipt-doc-2', accountId: 'native-checking', categoryId: 'native-food' });
    const inputs = calls.post.mock.calls.map(([, path, input]) => {
      expect(path).toBe('/api/evidence');
      return JSON.parse(input.content as string);
    });
    expect(inputs).toHaveLength(2);
    expect(calls.grant).toHaveBeenCalledWith(ctx, 'owner', 'account', 'native-checking', ['existence', 'transaction']);
    expect(calls.grant).toHaveBeenCalledWith(ctx, 'owner', 'category', 'native-food', ['category']);
    expect(new Set(inputs.map((input) => input.observations[0].externalEventId)).size).toBe(2);
    expect(inputs.map((input) => input.receipts[0].lines[0].net.minorUnits)).toEqual(['1200', '1200']);
    expect(inputs[1].receipts[0].lines[0].categoryId).toBe('native-food');
    expect(inputs.flatMap((input) => input.observations).every((row) => row.kind !== 'ledger_transaction' && row.ledgerTransactionId === null)).toBe(true);
    expect(calls.post).toHaveBeenCalledTimes(2);
  });
  it('requires an owner and accepts a current policy without optional overrides', async () => {
    const ctx = context('evidence-wallet-statement');
    for (const overrides of [{ clients: {} }, { personas: {} }])
      await expect(initializeWalletCategorizationEvidence({ ...ctx, ...overrides } as EvidenceScenarioSetup)).rejects.toThrow(/owner/);
    expect(calls.post).not.toHaveBeenCalled();
    calls.get.mockImplementation(async (path: string) => ({ status: 'ok', result: path.endsWith('/policy') ? { policy: { version: 'minimal-policy' } } : { wallets: [{ walletId: 'qualified-wallet' }] } }));
    await initializeWalletCategorizationEvidence(ctx);
    expect(calls.put).toHaveBeenCalledWith('/api/spaces/space/policy', { expectedVersion: 'minimal-policy', policy: { minimumApprovers: 2, assistanceMaximum: 'execute_approved_actions' } });
  });
  it('refuses a wallet source outside the validated native seed before changing policy', async () => {
    const ctx = context('evidence-wallet-statement');
    await expect(initializeWalletCategorizationEvidence({ ...ctx, seeded: { ...ctx.seeded, readResources: [] } })).rejects.toThrow(/outside the seeded Actual budget/);
    expect(calls.put).not.toHaveBeenCalled();
    expect(calls.post).not.toHaveBeenCalled();
    expect(calls.grant).not.toHaveBeenCalled();
  });
  it('fails closed if Actual mappings are unavailable or parsing did not succeed', async () => {
    const ctx = context('evidence-categorization');
    await expect(initializeWalletCategorizationEvidence({ ...ctx, seeded: { accountIds: {}, categoryIds: {} } } as unknown as EvidenceScenarioSetup)).rejects.toThrow();
    expect(calls.post).not.toHaveBeenCalled();
    calls.post.mockResolvedValue({ document: { id: 'bad', parseStatus: 'malformed' } });
    await expect(initializeWalletCategorizationEvidence(context('evidence-wallet-statement'))).rejects.toThrow(/parsed/);
    expect(calls.grant).not.toHaveBeenCalled();
  });
});

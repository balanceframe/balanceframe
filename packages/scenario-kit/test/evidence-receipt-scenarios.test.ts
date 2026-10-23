import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseManualReceiptPhoto } from '@balanceframe/application';

const mock = vi.hoisted(() => ({
  posts: [] as Array<{ path: string; body: Record<string, unknown> }>,
  grants: [] as unknown[][],
  documents: new Map<string, Record<string, unknown>>(),
  missingDocumentId: false,
  policyWrites: [] as Record<string, unknown>[],
}));
vi.mock('../src/evidence-scenario-support.js', () => ({
  evidenceFixture: (name: string) => JSON.parse(readFileSync(new URL(`../../../protocol/fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown,
  evidenceString: (value: unknown, label: string) => {
    if (typeof value !== 'string' || !value) throw new Error(`${label} must be a string`);
    return value;
  },
  evidenceResult: (value: { result: Record<string, unknown> }) => value.result,
  evidenceGrant: async (...args: unknown[]) => { mock.grants.push(args); },
  evidencePost: async (_ctx: unknown, path: string, body: Record<string, unknown>) => {
    mock.posts.push({ path, body });
    const id = `document-${mock.posts.length}`;
    const extraction = body.userExtraction
      ? parseManualReceiptPhoto(body.userExtraction, String(mock.posts.length).padStart(64, 'a')).extraction
      : body.mediaType === 'application/json' ? JSON.parse(String(body.content)) as Record<string, unknown> : {};
    mock.documents.set(id, { id, extraction });
    return { document: mock.missingDocumentId ? {} : { id } };
  },
}));
import type { EvidenceScenarioSetup } from '../src/evidence-scenario-support.js';
import { initializeReceiptEvidence } from '../src/evidence-receipt-scenarios.js';

function context(id: string): EvidenceScenarioSetup {
  return {
    scenario: { id, anchor: '2026-10-22T12:00:00.000Z' },
    seeded: {
      budgetId: 'actual-budget',
      accountIds: { 'acct-checking': 'actual-checking' },
      categoryIds: { 'cat-groceries': 'actual-food', 'cat-household': 'actual-household' },
      transactionIds: { 'txn-evidence-700': 'actual-700', 'txn-evidence-500': 'actual-500' },
      readResources: [
        { resourceKind: 'account', resourceId: 'actual-checking' },
        { resourceKind: 'category', resourceId: 'actual-food' }, { resourceKind: 'category', resourceId: 'actual-household' },
        { resourceKind: 'transaction', resourceId: 'actual-700' }, { resourceKind: 'transaction', resourceId: 'actual-500' },
      ],
    },
    clients: { owner: {
      get: async (path: string) => ({ status: 'ok', result: path.endsWith('/policy') ? { policy: { version: 'policy-one', minimumApprovers: 1, approvalThresholds: [], operationApprovers: {} } } : { document: mock.documents.get(decodeURIComponent(path.split('/').at(-1)!)) } }),
      reauthenticate: async () => {},
      put: async (_path: string, body: Record<string, unknown>) => { mock.policyWrites.push(body); return { status: 'ok', result: { policy: { version: 'policy-two' } } }; },
    } },
    personas: { owner: { actorId: 'owner', spaceId: 'scenario-space', password: 'fictional' }, coapprover: { actorId: 'reviewer' }, approver: { actorId: 'second-reviewer' }, restricted: { actorId: 'restricted' } },
  } as unknown as EvidenceScenarioSetup;
}
beforeEach(() => { mock.posts.length = 0; mock.grants.length = 0; mock.policyWrites.length = 0; mock.documents.clear(); mock.missingDocumentId = false; });
describe('receipt evidence local scenario initialization', () => {
  it('leaves unrelated scenario families untouched', async () => {
    expect(await initializeReceiptEvidence(context('funded-now'))).toEqual({});
    expect(mock.posts).toEqual([]);
  });
  it('imports manual photo, manual PDF, unsupported PDF, and mismatched item totals without source authority', async () => {
    const result = await initializeReceiptEvidence(context('evidence-receipt-intake'));
    expect(Object.keys(result)).toEqual(expect.arrayContaining(['photoDocumentId', 'photoReceiptId', 'pdfDocumentId', 'unparsedDocumentId', 'mismatchReceiptId']));
    expect(mock.posts.map(({ body }) => body.mediaType)).toEqual(['image/jpeg', 'application/pdf', 'application/pdf', 'image/jpeg']);
    expect(mock.posts.every(({ path, body }) => path === '/api/evidence' && body.visibility === 'private')).toBe(true);
    expect(mock.grants.every((args) => args[1] === 'owner' && args[2] === 'evidence' && String(args[3]).startsWith('document-'))).toBe(true);
    expect(mock.posts[0]!.body.userExtraction).not.toHaveProperty('actorId');
  });
  it('derives the plural receipt from the canonical matrix with two conserved items and split tenders', async () => {
    const ids = await initializeReceiptEvidence(context('evidence-plural-allocation'));
    expect(ids).toMatchObject({ receiptId: 'receipt-1', lineOneId: 'line-1', lineTwoId: 'line-2', targetOneId: 'actual-700', targetTwoId: 'actual-500' });
    expect(mock.posts[0]!.body.visibility).toBe('shared');
    expect(mock.policyWrites).toEqual([{ expectedVersion: 'policy-one', policy: { minimumApprovers: 2, approvalThresholds: [], operationApprovers: {}, assistanceMaximum: 'execute_approved_actions' } }]);
    expect(mock.grants.filter((args) => args[2] === 'transaction' && JSON.stringify(args[4]) === '["transaction.view","transaction"]').map((args) => [args[3], args[4]])).toEqual([
      ['actual-700', ['transaction.view', 'transaction']], ['actual-500', ['transaction.view', 'transaction']],
    ]);
    expect(mock.grants.some((args) => args[2] === 'account' && args[3] === 'actual-checking' && JSON.stringify(args[4]) === '["transaction"]')).toBe(true);
    expect(mock.grants.filter((args) => args[1] === 'owner' && args[2] === 'ledger_effect' && (args[4] as string[]).includes('ledger_projection:propose')).map((args) => [args[1], args[3], args[4]])).toEqual([
      ['owner', 'actual-700', ['ledger_projection:propose', 'ledger_projection:execute']],
      ['owner', 'actual-500', ['ledger_projection:propose', 'ledger_projection:execute']],
    ]);
    for (const reviewer of ['coapprover', 'approver']) {
      const grants = mock.grants.filter((args) => args[1] === reviewer);
      expect(grants.length).toBeGreaterThan(0);
      expect(grants.some((args) => args[2] === 'evidence' && args[3] === 'document-1' && (args[4] as string[]).includes('source'))).toBe(true);
      expect(grants.some((args) => args[2] === 'ledger_effect' && args[3] === 'actual-700' && (args[4] as string[]).includes('ledger_projection:approve'))).toBe(true);
      expect(grants.some((args) => args[2] === 'budget' && (args[4] as string[]).includes('full-read'))).toBe(false);
      expect(grants.some((args) => (args[4] as string[]).some((right) => right.endsWith(':execute')))).toBe(false);
      expect(grants.filter((args) => (args[4] as string[]).includes('transaction')).map((args) => [args[2], args[3]])).toEqual([
        ['account', 'actual-checking'], ['transaction', 'actual-700'], ['transaction', 'actual-500'],
      ]);
      expect(grants.some((args) => args[2] === 'budget' && (args[4] as string[]).includes('resolve'))).toBe(true);
      expect(grants.some((args) => args[2] === 'evidence' && args[3] === 'document-1' && (args[4] as string[]).includes('resolve'))).toBe(true);
    }
    const extraction = JSON.parse(String(mock.posts[0]!.body.content)) as { observations: Array<Record<string, unknown>>; receipts: Array<{ lines: Array<{ net: unknown; categoryId: unknown }>; tenders: Array<{ observationId: unknown }> }> };
    expect(extraction.observations).toHaveLength(1);
    expect(extraction.observations[0]).toMatchObject({ kind: 'receipt', reliability: 0, fundingInstrumentId: 'actual-checking' });
    expect(extraction.receipts[0]!.lines.map((line) => line.net)).toEqual(Array(2).fill({ minorUnits: '600', currency: 'USD' }));
    expect(extraction.receipts[0]!.lines.every((line) => line.categoryId === null)).toBe(true);
    expect(extraction.receipts[0]!.tenders.every((tender) => tender.observationId === null)).toBe(true);
  });
  it('creates distinct purchase, partial refunds, replacement, unrelated receipt, and order selectors', async () => {
    const ids = await initializeReceiptEvidence(context('evidence-return-lifecycle'));
    expect(ids).toMatchObject({ purchaseDocumentId: 'document-1', refundDocumentId: 'document-2', excessRefundDocumentId: 'document-3', replacementDocumentId: 'document-4', unrelatedDocumentId: 'document-5', orderDocumentId: 'document-6' });
    expect(new Set([ids.purchaseReceiptId, ids.refundReceiptId, ids.replacementReceiptId]).size).toBe(3);
    expect(mock.posts[1]!.body.userExtraction).toMatchObject({ kind: 'refund', total: { minorUnits: '600' } });
    expect(mock.posts[2]!.body.userExtraction).toMatchObject({ kind: 'refund', total: { minorUnits: '700' } });
    expect(mock.posts[2]!.body.userExtraction).toMatchObject({ receipt: { tax: { minorUnits: '100' }, lines: [{ quantityMicros: 1_000_000, unitGross: { minorUnits: '600' }, gross: { minorUnits: '600' }, tax: { minorUnits: '100' }, net: { minorUnits: '700' } }] } });
    expect(JSON.parse(String(mock.posts[5]!.body.content))).toMatchObject({ observations: [{ kind: 'order', status: 'pending' }] });
    expect(mock.posts[1]!.body.mediaType).toBe('application/pdf');
    expect(Buffer.from(String(mock.posts[1]!.body.content), 'base64').toString()).toContain('REFUND $6.00');
    expect(Buffer.from(String(mock.posts[2]!.body.content), 'base64').toString()).toContain('REFUND $7.00');
  });
  it('fails closed before grants if ingestion omits a validated document identity', async () => {
    mock.missingDocumentId = true;
    await expect(initializeReceiptEvidence(context('evidence-receipt-intake'))).rejects.toThrow();
    expect(mock.grants).toEqual([]);
  });
  it('rejects a missing seeded parent before importing a plural recipe', async () => {
    const ctx = context('evidence-plural-allocation');
    delete (ctx.seeded.transactionIds as Record<string, string>)['txn-evidence-500'];
    await expect(initializeReceiptEvidence(ctx)).rejects.toThrow(/txn-evidence-500/);
    expect(mock.posts).toEqual([]);
  });
  it.each(['client', 'persona'])('rejects missing owner %s before changing policy or importing', async (missing) => {
    const ctx = context('evidence-plural-allocation');
    if (missing === 'client') delete (ctx.clients as Record<string, unknown>).owner;
    else delete (ctx.personas as Record<string, unknown>).owner;
    await expect(initializeReceiptEvidence(ctx)).rejects.toThrow('Plural receipt owner unavailable');
    expect(mock.policyWrites).toEqual([]);
    expect(mock.posts).toEqual([]);
  });
});

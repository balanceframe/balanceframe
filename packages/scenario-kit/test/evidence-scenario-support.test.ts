import { describe, expect, it } from 'vitest';
import {
  evidenceFixture, evidenceGrant, evidencePost, evidenceResult, evidenceString, evidenceValue,
  type EvidenceScenarioSetup,
} from '../src/evidence-scenario-support.js';

describe('evidence scenario support', () => {
  it('unwraps successful results and refuses missing, failed or wrongly shaped values', () => {
    expect(evidenceValue({ status: 'ok', result: ['line'] }, 'lines')).toEqual(['line']);
    expect(evidenceResult({ status: 'ok', result: { id: 'document' } }, 'document')).toEqual({ id: 'document' });
    for (const value of [null, {}, { status: 'error', result: {} }, { status: 'ok' }])
      expect(() => evidenceValue(value, 'fixture')).toThrow(/fixture/);
    for (const result of [null, [], 'id'])
      expect(() => evidenceResult({ status: 'ok', result }, 'document')).toThrow(/document/);
    expect(evidenceString('document-id', 'id')).toBe('document-id');
    for (const value of ['', null, 1]) expect(() => evidenceString(value, 'id')).toThrow(/id/);
  });

  it('loads only registered canonical evidence fixtures and returns independent values', () => {
    const fixture = evidenceFixture('transaction-evidence-receipt');
    expect(fixture).toHaveProperty('receipts');
    expect(evidenceFixture('transaction-evidence-receipt')).not.toBe(fixture);
    expect(() => evidenceFixture('../../package')).toThrow(/registered/);
  });

  it('uses current owner proof and exact selected-space grant tuples', async () => {
    const calls: unknown[] = [];
    const context = {
      clients: { owner: {
        async reauthenticate(password: string) { calls.push(['reauth', password]); },
        async post(path: string, body: unknown) { calls.push(['post', path, body]); return { status: 'ok', result: ['saved'] }; },
        async put(path: string, body: unknown) { calls.push(['put', path, body]); return { status: 'ok', result: {} }; },
      } },
      personas: {
        owner: { spaceId: 'space', membershipId: 'owner-membership', password: 'fictional-proof' },
        coapprover: { spaceId: 'space', membershipId: 'peer-membership' },
      },
    } as unknown as EvidenceScenarioSetup;
    expect(await evidencePost<string[]>(context, '/api/evidence/resolve', {})).toEqual(['saved']);
    await evidenceGrant(context, 'coapprover', 'evidence', 'exact-document', ['normalized-evidence', 'proposal']);
    expect(calls).toEqual([
      ['reauth', 'fictional-proof'], ['post', '/api/evidence/resolve', {}],
      ['reauth', 'fictional-proof'],
      ['put', '/api/spaces/space/grants', { membershipId: 'peer-membership', resourceKind: 'evidence', resourceId: 'exact-document', capability: 'normalized-evidence', granted: true }],
      ['put', '/api/spaces/space/grants', { membershipId: 'peer-membership', resourceKind: 'evidence', resourceId: 'exact-document', capability: 'proposal', granted: true }],
    ]);
    await expect(evidenceGrant(context, 'unknown', 'evidence', 'exact-document', ['source'])).rejects.toThrow(/persona/);
  });
});

import { describe, expect, it } from 'vitest';
import { merchantPolicyViewSchema, merchantResearchPreviewSchema, merchantResearchOutcomeSchema, merchantResearchCacheSchema, merchantResearchPolicyViewSchema } from '../src/merchant-public.js';

const scope = { spaceId: 'public-space', budgetId: 'public-budget', connectionId: 'public-connection' };
const value = { mode: 'local-only', allowedProviderIds: [], maxSearchesPerDay: 0, maxSpendMinorUnitsPerMonth: 0, billingCurrency: 'USD', cacheTtlHours: 24 };
const policy = { scope, value, version: 0, generation: 0 };
const ready = { status: 'ready', previewToken: 'b'.repeat(64), merchant: 'Explicit Public Business', locale: null, providerId: 'valueserp', providerVersion: 'valueserp-search/1', evidenceKey: 'merchant:transaction:fixture', evidenceRevision: 'a'.repeat(64), expiresAt: '2026-10-04T12:05:00.000Z', fieldsSent: ['merchant', 'locale'], disclosure: 'External search may retain public text and server IP; sent requests cannot be recalled.', maxCostAtoms: '9007199254740993000001', billingCurrency: 'USD' };
describe('public merchant response contracts', () => {
  it('preserves exact non-floating atom prices and complete consent binding in a valid preview', () => {
    const parsed = merchantResearchPreviewSchema.parse(ready);
    expect(parsed).toEqual(ready);
  });
  it.each([{ ...ready, maxCostAtoms: 1.25 }, { ...ready, maxCostAtoms: '0' }, { ...ready, fieldsSent: ['merchant', 'notes'] }, { ...ready, apiKey: 'PRIVATE-KEY' }, { ...ready, evidenceRevision: 'not-current' }])('rejects malformed cost, private fields or authority-bearing preview payloads', (input) => {
    expect(merchantResearchPreviewSchema.safeParse(input).success).toBe(false);
  });
  it('retains content-free denied, uncertain and pending states without manufacturing enrichment', () => {
    expect(merchantResearchPreviewSchema.parse({ status: 'denied', code: 'configuration' })).toEqual({ status: 'denied', code: 'configuration' });
    expect(merchantResearchOutcomeSchema.parse({ status: 'failed', code: 'timeout', billing: 'uncertain' })).toEqual({ status: 'failed', code: 'timeout', billing: 'uncertain' });
    expect(merchantResearchOutcomeSchema.parse({ status: 'pending', attemptId: 'pending-owned' })).toEqual({ status: 'pending', attemptId: 'pending-owned' });
    expect(merchantResearchCacheSchema.parse({ enrichment: null })).toEqual({ enrichment: null });
    expect(merchantResearchOutcomeSchema.safeParse({ status: 'failed', code: 'timeout', billing: 'uncertain', query: 'PRIVATE' }).success).toBe(false);
  });
  it('validates complete independent policy provenance and refuses unsafe counters and partial layers', () => {
    expect(merchantPolicyViewSchema.parse(policy)).toEqual(policy);
    const view = { installation: { value, version: 'unconfigured' }, space: { ...policy, scope: { ...scope, connectionId: 'merchant:space-policy' } }, budget: policy,
      resolved: { mode: 'local-only', allowedProviderIds: [], billingCurrency: 'USD', cacheTtlHours: 24, maxSearchesPerDay: 0, maxSpendMinorUnitsPerMonth: 0,
        layers: ['installation', 'space', 'budget'].map((kind) => ({ kind, version: '0', mode: 'local-only', reason: 'missing' })) } };
    expect(merchantResearchPolicyViewSchema.parse(view)).toEqual(view);
    expect(merchantResearchPolicyViewSchema.safeParse({ ...view, resolved: { ...view.resolved, layers: view.resolved.layers.slice(1) } }).success).toBe(false);
    expect(merchantPolicyViewSchema.safeParse({ ...policy, value: { ...value, maxSearchesPerDay: Number.MAX_SAFE_INTEGER + 1 } }).success).toBe(false);
  });
});

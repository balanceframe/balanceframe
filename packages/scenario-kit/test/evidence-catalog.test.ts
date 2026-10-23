import { describe, expect, it } from 'vitest';
import { listScenarios, materializeScenario } from '../src/catalog.js';
import { isScenarioId, scenarioFeatureWrite } from '../src/scenario-manifest.js';

const stories = [
  'evidence-receipt-intake', 'evidence-plural-allocation', 'evidence-return-lifecycle',
  'evidence-wallet-statement', 'evidence-categorization',
] as const;

describe('v0.9 evidence demo catalog', () => {
  it('registers five independently materialized /evidence stories alongside existing stories', () => {
    expect(listScenarios()).toHaveLength(45);
    for (const id of stories) {
      expect(listScenarios().find((story) => story.id === id)).toMatchObject({ featureGroup: 'Evidence' });
      const scenario = materializeScenario(id, new Date('2026-10-22T12:00:00Z'));
      expect(scenario.entry).toEqual({ kind: 'page', path: '/evidence' });
      expect(scenario.personas.map((persona) => persona.id)).toEqual(['owner', 'coapprover', 'approver', 'restricted']);
      expect(scenario.personas.find((persona) => persona.id === 'restricted')?.grants
        .some((grant) => grant.resourceKind === 'evidence')).toBe(false);
      const other = materializeScenario(id, new Date('2026-10-22T12:00:00Z'));
      expect(other).toEqual(scenario);
      expect(other).not.toBe(scenario);
    }
  });

  it('seeds exact imported parent amounts and distinct split categories for plural allocation', () => {
    const scenario = materializeScenario('evidence-plural-allocation', new Date('2026-10-22T12:00:00Z'));
    expect(scenario.ledger.transactions.map(({ id, amount, importedId }) => ({ id, amount: amount.minorUnits, importedId })))
      .toEqual([
        { id: 'txn-evidence-700', amount: '-700', importedId: 'fictional-evidence-700' },
        { id: 'txn-evidence-500', amount: '-500', importedId: 'fictional-evidence-500' },
      ]);
    expect(scenario.ledger.categories.map(({ id }) => id)).toContain('cat-household');
  });

  it('allows plural reviewers to make their own evidence review without financial execution', () => {
    for (const id of ['evidence-plural-allocation', 'evidence-wallet-statement'] as const) {
      const scenario = materializeScenario(id, new Date('2026-10-22T12:00:00Z'));
      for (const reviewer of scenario.personas.filter(({ id }) => id === 'coapprover' || id === 'approver')) {
        expect(reviewer.membership.capabilities.includes('resolve')).toBe(id === 'evidence-plural-allocation');
        expect(reviewer.membership.capabilities.includes('transaction')).toBe(id === 'evidence-plural-allocation');
        expect(reviewer.membership.capabilities.some((right) => right.endsWith(':execute'))).toBe(false);
      }
    }
  });

  it('admits only declared story writes, never arbitrary evidence or cross-family mutations', () => {
    for (const id of stories) {
      if (!isScenarioId(id)) throw new Error(`Unregistered story ${id}`);
      expect(scenarioFeatureWrite(id, 'POST', '/api/evidence')).toBe(true);
      expect(scenarioFeatureWrite(id, 'POST', '/api/evidence/resolve')).toBe(true);
      expect(scenarioFeatureWrite(id, 'POST', '/api/evidence/unknown')).toBe(false);
      expect(scenarioFeatureWrite(id, 'DELETE', '/api/evidence')).toBe(false);
      expect(scenarioFeatureWrite(id, 'POST', '/api/merchant/research')).toBe(false);
    }
    if (!isScenarioId('evidence-receipt-intake') || !isScenarioId('evidence-plural-allocation'))
      throw new Error('Missing evidence stories');
    expect(scenarioFeatureWrite('evidence-receipt-intake', 'POST', '/api/evidence/extract-photo')).toBe(true);
    expect(scenarioFeatureWrite('evidence-receipt-intake', 'POST', '/api/proposal/p/execute')).toBe(false);
    expect(scenarioFeatureWrite('evidence-plural-allocation', 'POST', '/api/proposal/p/execute')).toBe(true);
    expect(scenarioFeatureWrite('funded-purchase', 'POST', '/api/evidence')).toBe(false);
  });
});

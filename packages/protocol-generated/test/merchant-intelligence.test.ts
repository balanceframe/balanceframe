import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  merchantAnalysisRequestSchema,
  merchantAnalysisResultSchema,
  nativeRulePartSchema,
  validateNativeRuleTables,
} from '../src/validators';

const fixture = JSON.parse(
  fs.readFileSync(new URL('../../../protocol/fixtures/merchant-intelligence.json', import.meta.url), 'utf8'),
) as { request: unknown; result: unknown; recurrenceResult: unknown };

const request = () => merchantAnalysisRequestSchema.parse(fixture.request);
const result = () => merchantAnalysisResultSchema.parse(fixture.result);
const recurrenceResult = () => merchantAnalysisResultSchema.parse(fixture.recurrenceResult);

function transactionWith(patch: Record<string, unknown>) {
  const input = request();
  return { ...input, transactions: [{ ...input.transactions[0], ...patch }] };
}

function recurrenceWith(patch: Record<string, unknown>) {
  const output = recurrenceResult();
  return { ...output, recurrences: [{ ...output.recurrences[0], ...patch }] };
}

describe('canonical merchant intelligence boundary', () => {
  it('round-trips shared source availability, raw text, stable IDs and admission without filling gaps', () => {
    expect(request()).toEqual(fixture.request);
    const tx = request().transactions[0];
    expect(tx.importedPayee).toEqual({ state: 'present', value: '  CORNER—MARKET  ' });
    expect(tx.description).toEqual({ state: 'unsupported', value: null });
    expect(tx.verboseTitle).toEqual({ state: 'absent', value: null });
    expect(tx.notes).toEqual({ state: 'empty', value: '' });
    expect(tx.payeeId).toBe('payee-market');
    expect(tx.occurrenceId).toBe('tx-source');
    expect(request().sourceAdmission.sourceCategoryIds).toEqual([
      'category-food', 'category-bills', 'category-other',
    ]);
  });

  it('preserves exact merchant Money and rejects malformed observations in a native Node consumer', () => {
    const fixtureUrl = new URL('../../../protocol/fixtures/merchant-intelligence.json', import.meta.url).href;
    const checked = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { merchantAnalysisRequestSchema } from '@balanceframe/protocol-generated/validators';
      const fixture = JSON.parse(readFileSync(new URL(${JSON.stringify(fixtureUrl)}), 'utf8'));
      const admitted = merchantAnalysisRequestSchema.parse(fixture.request);
      assert.equal(admitted.transactions[0].amount.minorUnits, '-100');
      assert.equal(admitted.transactions[0].amount.currency, 'USD');
      for (const minorUnits of ['-0', '01', '9223372036854775808']) {
        const invalid = structuredClone(admitted);
        invalid.transactions[0].amount.minorUnits = minorUnits;
        assert.equal(merchantAnalysisRequestSchema.safeParse(invalid).success, false);
      }
      const incoherent = structuredClone(admitted);
      incoherent.transactions[0].importedPayee = { state: 'unsupported', value: 'Invented bank text' };
      assert.equal(merchantAnalysisRequestSchema.safeParse(incoherent).success, false);
    `], { encoding: 'utf8', timeout: 10_000 });
    expect(checked.status, checked.stderr).toBe(0);
  });

  it('round-trips local evidence and recurrence maps as objects, with schedules separate from observations', () => {
    expect(result()).toEqual(fixture.result);
    expect(recurrenceResult()).toEqual(fixture.recurrenceResult);
    const output = recurrenceResult();
    expect(output.recurrences[0].dayOfMonth).toEqual({ '29': 1, '31': 2 });
    expect(output.recurrences[0].occurrencesPerWeek.countDistribution).toEqual({ '0': 6, '1': 3 });
    expect(output.recurrences[0].occurrencesPerMonth.averageNumerator).toBe('1');
    expect(output.recurrences[0].varianceNumerator).toBe('20000');
    expect(output.recurrences[0].varianceDenominator).toBe('3');
    expect(output.scheduledExpectations[0].source.certainty).toBe('range');
    expect(output.scheduledExpectations[0].source.recurrence?.weekendSolveMode).toBe('after');
    expect(output.scheduledExpectations[0]).not.toHaveProperty('varianceNumerator');
  });
  it('requires complete compact category targets with strict identity, tiers and source closure', () => {
    const base = structuredClone(fixture.result) as Record<string, unknown>;
    const target = {
      transactionId: 'tx-compact-result', accountId: 'account-checking', payeeId: null,
      categoryId: 'category-food', tier: 'inferred', evidenceRevision: 'compact-result-revision',
    };
    const output = { ...base, categoryClassifications: [target] };
    expect(merchantAnalysisResultSchema.parse(output)).toEqual(output);
    const missing = { ...base };
    delete missing.categoryClassifications;
    expect(merchantAnalysisResultSchema.safeParse(missing).success).toBe(false);
    for (const patch of [
      { accountId: 'account-not-admitted' }, { categoryId: 'category-not-admitted' },
      { tier: 'deterministic_match' }, { tier: 'conflicting' }, { tier: 'insufficient_data' },
      { transactionId: '' }, { evidenceRevision: '' }, { payeeId: undefined }, { unexpected: true },
    ]) {
      expect(merchantAnalysisResultSchema.safeParse({
        ...base, categoryClassifications: [{ ...target, ...patch }],
      }).success, JSON.stringify(patch)).toBe(false);
    }
    expect(merchantAnalysisResultSchema.safeParse({
      ...base, categoryClassifications: [target, target],
    }).success).toBe(false);
    expect(merchantAnalysisResultSchema.safeParse({
      ...output,
      nativeRuleBlocks: [{ ruleIds: ['rule-compact-collision'] }],
      nativeRuleParts: [{ blockIndexes: [0] }],
      nativeRuleSets: [{ orPartIndexes: [0], andPartIndexes: [], categoryPartIndex: 0 }],
      nativeRuleClassifications: [{
        transactionId: target.transactionId, accountId: target.accountId,
        categoryId: target.categoryId, ruleSetIndex: 0,
      }],
    }).success).toBe(false);
  });

  it('round-trips full recurrence endpoints independently of bounded date samples', () => {
    const output = merchantAnalysisResultSchema.parse(recurrenceWith({
      transactionIds: ['tx-february'], dates: ['2024-02-29'], intervalDays: [],
    }));
    expect(output.recurrences[0]).toMatchObject({
      firstDate: '2024-01-31', lastDate: '2024-03-31',
      dates: ['2024-02-29'], occurrences: 3,
    });
  });

  it.each([
    { firstDate: '2024-02-30' }, { lastDate: '2023-02-29' },
    { firstDate: '2024-01-31T00:00:00Z' }, { lastDate: null }, { firstDate: undefined },
    { firstDate: '2024-04-01', lastDate: '2024-01-01' },
    { firstDate: '2024-02-01' }, { lastDate: '2024-03-30' },
  ])('rejects invalid, missing, reversed, or out-of-sample full recurrence endpoints: %j', (patch) => {
    expect(merchantAnalysisResultSchema.safeParse(recurrenceWith(patch)).success).toBe(false);
  });

  it.each([
    { state: 'present', value: null },
    { state: 'present', value: '' },
    { state: 'empty', value: null },
    { state: 'empty', value: 'not empty' },
    { state: 'absent', value: '' },
    { state: 'unsupported', value: 'invented' },
    { state: 'unavailable', value: '' },
    { state: 'unavailable', value: 'private source text' },
    { state: 'unavailable' },
    { state: 'unknown', value: null },
    { state: 'present', value: 'text', providerObject: {} },
  ])('rejects incoherent availability rather than coercing %j', (field) => {
    for (const name of ['importedPayee', 'description', 'verboseTitle', 'notes']) {
      expect(merchantAnalysisRequestSchema.safeParse(transactionWith({ [name]: field })).success).toBe(false);
    }
  });

  it.each(['2023-02-29', '2024-02-30', '2024-13-01', '2024-3-01', '2024-03-31T00:00:00Z'])(
    'rejects invalid or timestamp civil date %s',
    (date) => {
      expect(merchantAnalysisRequestSchema.safeParse(transactionWith({ date })).success).toBe(false);
      expect(merchantAnalysisRequestSchema.safeParse({ ...request(), asOfDate: date }).success).toBe(false);
    },
  );

  it.each(['9223372036854775807', '-9223372036854775808', '0'])(
    'preserves signed-i64 Money boundary %s as a string',
    (minorUnits) => {
      const input = transactionWith({ amount: { minorUnits, currency: 'JPY' } });
      expect(merchantAnalysisRequestSchema.parse(input).transactions[0].amount).toEqual({ minorUnits, currency: 'JPY' });
    },
  );

  it.each([1, '1.5', '01', '-0', '9223372036854775808', '-9223372036854775809'])(
    'rejects noncanonical or overflowing Money %s',
    (minorUnits) => {
      expect(merchantAnalysisRequestSchema.safeParse(transactionWith({ amount: { minorUnits, currency: 'USD' } })).success).toBe(false);
    },
  );

  it.each(['', 'usd', 'US', 'USDD'])(
    'does not invent a currency from %s',
    (currency) => {
      expect(merchantAnalysisRequestSchema.safeParse(transactionWith({ amount: { minorUnits: '-100', currency } })).success).toBe(false);
    },
  );

  it('enforces schema versions, opaque nonempty IDs, evidence/horizon bounds and source admission', () => {
    for (const patch of [
      { schemaVersion: '2' }, { normalizationVersion: 'merchant/1' },
      { horizonYears: 0 }, { horizonYears: 11 }, { maxEvidence: 0 }, { maxEvidence: 101 },
      { maxEvidence: 1.5 }, { snapshotId: '' }, { sourceAdmission: undefined },
      { scope: { ...request().scope, budgetId: '' } },
    ]) {
      expect(merchantAnalysisRequestSchema.safeParse({ ...request(), ...patch }).success).toBe(false);
    }
    expect(merchantAnalysisRequestSchema.safeParse(transactionWith({ id: '' })).success).toBe(false);
    expect(merchantAnalysisRequestSchema.safeParse(transactionWith({ occurrenceId: '' })).success).toBe(false);
    expect(merchantAnalysisRequestSchema.safeParse({ ...request(), maxEvidence: 1, horizonYears: 10 }).success).toBe(true);
  });

  it('admits payeeName aliases as independent native display evidence but rejects unknown source fields', () => {
    const input = request();
    const alias = {
      id: 'alias-native-name', sourceText: input.transactions[0].payeeName!,
      sourceField: 'payeeName', targetPayeeId: input.payees[0].id,
      accountId: input.transactions[0].accountId, state: 'accepted', actorId: 'actor-human',
      version: 1, updatedAt: input.sourceAdmission.capturedAt, sourceTransactionIds: [input.transactions[0].id],
    };
    expect(merchantAnalysisRequestSchema.parse({ ...input, aliases: [alias] }).aliases[0]).toEqual(alias);
    expect(merchantAnalysisRequestSchema.safeParse({
      ...input, aliases: [{ ...alias, sourceField: 'unknownNativeField' }],
    }).success).toBe(false);
    expect(merchantAnalysisRequestSchema.safeParse({
      ...input, aliases: [{ ...alias, clientGrantedSourceRead: true }],
    }).success).toBe(false);
  });

  it('rejects unknown fields at every new boundary instead of silently stripping assertions', () => {
    expect(merchantAnalysisRequestSchema.safeParse({ ...request(), providerResults: [] }).success).toBe(false);
    expect(merchantAnalysisRequestSchema.safeParse(transactionWith({ nativeExecutionConfirmed: true })).success).toBe(false);
    expect(merchantAnalysisRequestSchema.safeParse({
      ...request(), sourceAdmission: { ...request().sourceAdmission, authorizedByClient: true },
    }).success).toBe(false);
    expect(merchantAnalysisResultSchema.safeParse({ ...result(), confidence: 1 }).success).toBe(false);
    for (const field of ['transactionIdentity', 'economicObligationId', 'executionResult']) {
      const output = result();
      expect(merchantAnalysisResultSchema.safeParse({
        ...output,
        suggestions: [{
          ...output.suggestions[0],
          evidence: [{ ...output.suggestions[0].evidence[0], [field]: 'invented' }],
        }],
      }).success).toBe(false);
    }
  });

  it('validates calendar dates and explicit zone without inferring jurisdiction from Money', () => {
    const input = request();
    expect(merchantAnalysisRequestSchema.safeParse({ ...input, calendars: [] }).success).toBe(true);
    expect(merchantAnalysisRequestSchema.safeParse({
      ...input, calendars: [{ ...input.calendars[0], timeZone: 'Not/AZone' }],
    }).success).toBe(false);
    expect(merchantAnalysisRequestSchema.safeParse({
      ...input, calendars: [{ ...input.calendars[0], holidays: [{ date: '2024-02-30', name: 'Invented' }] }],
    }).success).toBe(false);
    expect(merchantAnalysisRequestSchema.safeParse({
      ...input, calendars: [{ ...input.calendars[0], jurisdiction: 'ZZ' }],
    }).success).toBe(true);
  });

  it('allows paired null checked-overflow variance but never a partial or fake numeric rational', () => {
    expect(merchantAnalysisResultSchema.safeParse(recurrenceWith({
      varianceNumerator: null, varianceDenominator: null, reasonCodes: ['amount_statistics_overflow'],
    })).success).toBe(true);
    for (const patch of [
      { varianceNumerator: '-1' }, { varianceNumerator: '01' },
      { varianceNumerator: '170141183460469231731687303715884105728' },
      { varianceDenominator: '0' }, { varianceDenominator: null },
      { varianceNumerator: null }, { varianceNumerator: 20000 },
      { varianceNumerator: null, varianceDenominator: null, reasonCodes: [] },
    ]) {
      expect(merchantAnalysisResultSchema.safeParse(recurrenceWith(patch)).success).toBe(false);
    }
  });

  it('rejects invalid distribution domains, array maps, negative counts and zero denominators', () => {
    for (const patch of [
      { dayOfMonth: { '32': 1 } }, { dayOfWeek: { '0': 1 } }, { monthOfYear: { '13': 1 } },
      { yearDistribution: { twenty: 1 } }, { dayOfMonth: { '1': -1 } },
      { dayOfWeek: [['3', 1]] }, { kind: 'scheduled' }, { decisionState: 'executed' },
    ]) {
      expect(merchantAnalysisResultSchema.safeParse(recurrenceWith(patch)).success).toBe(false);
    }
    const distribution = recurrenceResult().recurrences[0].occurrencesPerWeek;
    for (const patch of [
      { periodCounts: [['2024-W05', 1]] }, { periodCounts: { '2024-W54': 1 } },
      { countDistribution: { '1': -1 } }, { averageDenominator: '0' },
      { averageNumerator: 1 },
    ]) {
      expect(merchantAnalysisResultSchema.safeParse(recurrenceWith({
        occurrencesPerWeek: { ...distribution, ...patch },
      })).success).toBe(false);
    }
  });

  it('represents unadmitted source text without claiming absence or retaining private values', () => {
    for (const field of ['importedPayee', 'description', 'verboseTitle', 'notes'] as const) {
      const input = transactionWith({ [field]: { state: 'unavailable', value: null } });
      expect(merchantAnalysisRequestSchema.parse(input).transactions[0][field])
        .toEqual({ state: 'unavailable', value: null });
      expect(merchantAnalysisRequestSchema.safeParse(
        transactionWith({ [field]: { state: 'unavailable', value: 'private source text' } }),
      ).success).toBe(false);
    }
  });

  it('preserves rejected findings and unknown schedule facts without upgrading them to execution', () => {
    expect(merchantAnalysisResultSchema.parse(recurrenceWith({
      decisionState: 'rejected', reasonCodes: ['pattern_rejected'],
    })).recurrences[0].decisionState).toBe('rejected');
    const output = recurrenceResult();
    const expectation = output.scheduledExpectations[0];
    const unknown = {
      ...output,
      scheduledExpectations: [{
        ...expectation,
        source: { ...expectation.source, certainty: 'unknown', amount: null, minimum: null, maximum: null, recurrence: null },
      }],
    };
    expect(merchantAnalysisResultSchema.parse(unknown).scheduledExpectations[0].source.amount).toBeNull();
  });
});

describe('full native merchant Review aggregates', () => {
  function extendedResult() {
    const base = structuredClone(fixture.result) as { suggestions: Record<string, unknown>[] };
    return {
      ...base,
      suggestions: base.suggestions.map((suggestion) => ({
        ...suggestion,
        categoryHistory: {
          totalCount: 7, categoryCount: 2, truncated: true, entries: [{
            categoryId: 'category-food', count: 6, ledgerCount: 5, correctionCount: 1,
            firstDate: '2024-01-01', lastDate: '2024-03-31',
          }],
        },
        alternatives: [{
          categoryId: 'category-bills', supportCount: 1, tier: 'insufficient_data', reasonCodes: ['scoped_history'],
        }],
        ruleCandidates: [] as {
          payeeId: string; categoryId: string; supportCount: number;
          consistencyNumerator: number; consistencyDenominator: number;
        }[],
      })),
      nativeRuleBlocks: [{ ruleIds: ['native-rule'] }],
      nativeRuleParts: [{ blockIndexes: [0] }],
      nativeRuleSets: [{ orPartIndexes: [0], andPartIndexes: [] as number[][], categoryPartIndex: 0 }],
      nativeRuleClassifications: [{
        transactionId: 'tx-source', accountId: 'account-checking', categoryId: 'category-bills', ruleSetIndex: 0,
      }],
    };
  }

  it('round-trips full history endpoints and outcome roles independently of bounded entries', () => {
    const output = extendedResult();
    expect(merchantAnalysisResultSchema.parse(output)).toEqual(output);
  });

  it.each([
    { count: -1 }, { count: 4294967296 }, { count: 1.5 }, { correctionCount: 2 },
    { firstDate: '2024-02-30' }, { lastDate: '2023-01-01' }, { ledgerCount: undefined },
    { confidence: 0.99 },
  ])('rejects invalid full-history entries: %j', (patch) => {
    const output = extendedResult();
    Object.assign(output.suggestions[0].categoryHistory.entries[0], patch);
    expect(merchantAnalysisResultSchema.safeParse(output).success).toBe(false);
  });

  it('rejects contradictory truncation, duplicate native transaction IDs and nonexact rule consistency', () => {
    const truncated = extendedResult();
    truncated.suggestions[0].categoryHistory.truncated = false;
    expect(merchantAnalysisResultSchema.safeParse(truncated).success).toBe(false);
    const duplicate = extendedResult();
    duplicate.nativeRuleClassifications.push({ ...duplicate.nativeRuleClassifications[0] });
    expect(merchantAnalysisResultSchema.safeParse(duplicate).success).toBe(false);
    const rule = extendedResult();
    rule.suggestions[0].ruleCandidates = [{
      payeeId: 'payee-market', categoryId: 'category-food',
      supportCount: 6, consistencyNumerator: 5, consistencyDenominator: 7,
    }];
    expect(merchantAnalysisResultSchema.safeParse(rule).success).toBe(false);
  });

  it('requires all three shared tables in every canonical result, including empty native outcomes', () => {
    for (const specimen of [fixture.result, fixture.recurrenceResult]) {
      expect(merchantAnalysisResultSchema.parse(specimen)).toEqual(specimen);
      for (const table of ['nativeRuleBlocks', 'nativeRuleParts', 'nativeRuleSets']) {
        const missing = { ...specimen as Record<string, unknown> };
        delete missing[table];
        expect(merchantAnalysisResultSchema.safeParse(missing).success).toBe(false);
      }
    }
  });

  it.each([null, -1, 0.5, '0', 1, 4294967296, undefined])('denies invalid or absent shared native indexes: %j', (ruleSetIndex) => {
    const output = extendedResult();
    expect(merchantAnalysisResultSchema.parse(output)).toEqual(output);
    expect(merchantAnalysisResultSchema.safeParse({
      ...output,
      nativeRuleClassifications: [{ ...output.nativeRuleClassifications[0], ruleSetIndex }],
    }).success).toBe(false);
  });

  it('denies missing/empty groups, inline IDs, and incomplete or noncanonical rule sets', () => {
    const output = extendedResult();
    expect(merchantAnalysisResultSchema.parse(output)).toEqual(output);
    const missing: Record<string, unknown> = { ...output };
    delete missing.nativeRuleSets;
    expect(merchantAnalysisResultSchema.safeParse(missing).success).toBe(false);
    expect(merchantAnalysisResultSchema.safeParse({ ...output, nativeRuleSets: [] }).success).toBe(false);
    expect(merchantAnalysisResultSchema.safeParse({
      ...output, nativeRuleClassifications: [{ ...output.nativeRuleClassifications[0], ruleIds: ['native-rule'] }],
    }).success).toBe(false);
    for (const ruleIds of [[], [''], ['native-rule', 'native-rule'], ['rule-b', 'rule-a']]) {
      expect(merchantAnalysisResultSchema.safeParse({ ...output, nativeRuleBlocks: [{ ruleIds }] }).success).toBe(false);
    }
  });

  it('round-trips complete non-ASCII native rule IDs in native lexical order without coercion', () => {
    const output = extendedResult();
    output.nativeRuleBlocks = [{ ruleIds: ['rule-\uE000', 'rule-\u{10000}'] }];
    expect(merchantAnalysisResultSchema.parse(output)).toEqual(output);
    output.nativeRuleBlocks[0].ruleIds.reverse();
    expect(merchantAnalysisResultSchema.safeParse(output).success).toBe(false);
  });

  it('accepts complete posting provenance then denies cross-block duplication, total overflow and malformed references', () => {
    const output = {
      ...extendedResult(),
      nativeRuleBlocks: [{ ruleIds: ['native-rule-a', 'native-rule-b'] }, { ruleIds: ['native-rule-c'] }],
      nativeRuleParts: [{ blockIndexes: [0, 1] }],
    };
    expect(merchantAnalysisResultSchema.parse(output)).toEqual(output);
    for (const field of ['nativeRuleBlocks', 'nativeRuleParts', 'nativeRuleSets']) {
      const missing: Record<string, unknown> = { ...output };
      delete missing[field];
      expect(merchantAnalysisResultSchema.safeParse(missing).success).toBe(false);
    }
    expect(merchantAnalysisResultSchema.safeParse({
      ...output, nativeRuleBlocks: [{ ruleIds: ['native-rule-a', 'native-rule-b'] }, { ruleIds: ['native-rule-b'] }],
    }).success).toBe(false);
    for (const blockIndexes of [[], [0, 0], [1, 0], [0, 2], [-1], [0.5], ['0'], [4294967296], null]) {
      expect(merchantAnalysisResultSchema.safeParse({
        ...output, nativeRuleParts: [{ blockIndexes }],
      }).success).toBe(false);
    }
    expect(merchantAnalysisResultSchema.safeParse({
      ...output, nativeRuleSets: [{ ...output.nativeRuleSets[0], ruleIds: ['native-rule-a', 'native-rule-b', 'native-rule-c'] }],
    }).success).toBe(false);
    const unicode = {
      ...output, nativeRuleBlocks: [{ ruleIds: ['rule-\uE000', 'rule-\u{10000}'] }, { ruleIds: ['native-rule-c'] }],
    };
    expect(merchantAnalysisResultSchema.parse(unicode)).toEqual(unicode);
    unicode.nativeRuleBlocks[0].ruleIds.reverse();
    expect(merchantAnalysisResultSchema.safeParse(unicode).success).toBe(false);
    const byteBound = {
      ...output, nativeRuleBlocks: [{ ruleIds: ['é'.repeat(128)] }, { ruleIds: ['native-rule-c'] }],
    };
    expect(merchantAnalysisResultSchema.parse(byteBound)).toEqual(byteBound);
    byteBound.nativeRuleBlocks[0].ruleIds = ['é'.repeat(129)];
    expect(merchantAnalysisResultSchema.safeParse(byteBound).success).toBe(false);
    expect(merchantAnalysisResultSchema.safeParse({
      ...output, nativeRuleBlocks: [
        { ruleIds: Array.from({ length: 50000 }, (_, index) => `total-rule-${String(index).padStart(6, '0')}`) },
        { ruleIds: Array.from({ length: 50001 }, (_, index) => `total-rule-${String(index + 50000).padStart(6, '0')}`) },
      ],
    }).success).toBe(false);
  });
  it('accepts overlapping fixed category-filtered posting expressions and denies empty classified intersections', () => {
    const output = {
      ...fixture.result as Record<string, unknown>,
      nativeRuleBlocks: [{ ruleIds: ['posting-a', 'posting-b'] }, { ruleIds: ['posting-c'] }],
      nativeRuleParts: [{ blockIndexes: [0, 1] }, { blockIndexes: [0] }, { blockIndexes: [1] }],
      nativeRuleSets: [{
        orPartIndexes: [0, 1], andPartIndexes: [[1, 2], [0], [0], [0]], categoryPartIndex: 0,
      }],
      nativeRuleClassifications: [{
        transactionId: 'tx-source', accountId: 'account-checking', categoryId: 'category-bills', ruleSetIndex: 0,
      }],
    };
    expect(merchantAnalysisResultSchema.parse(output)).toEqual(output);
    for (const expression of [
      { orPartIndexes: [], andPartIndexes: [], categoryPartIndex: 0 },
      { orPartIndexes: [], andPartIndexes: [[1], [2], [1], [2]], categoryPartIndex: 0 },
      { orPartIndexes: [1], andPartIndexes: [], categoryPartIndex: 2 },
      { orPartIndexes: [0, 0], andPartIndexes: [], categoryPartIndex: 0 },
      { orPartIndexes: [0], andPartIndexes: [[0], [0]], categoryPartIndex: 0 },
      { orPartIndexes: [0], andPartIndexes: [[0], [0], [0]], categoryPartIndex: 0 },
      { orPartIndexes: [], andPartIndexes: [[], [0], [0], [0]], categoryPartIndex: 0 },
      { orPartIndexes: [0], andPartIndexes: [[0, 1, 2], [0], [0], [0]], categoryPartIndex: 0 },
      { orPartIndexes: [0], andPartIndexes: [[0, 0], [0], [0], [0]], categoryPartIndex: 0 },
      { orPartIndexes: [0], andPartIndexes: [[1, 0], [0], [0], [0]], categoryPartIndex: 0 },
      { orPartIndexes: [0], andPartIndexes: [], categoryPartIndex: 3 },
      { orPartIndexes: [3], andPartIndexes: [], categoryPartIndex: 0 },
      { orPartIndexes: [0], andPartIndexes: [], categoryPartIndex: null },
      { orPartIndexes: [0], andPartIndexes: [] },
      { orPartIndexes: [0], andPartIndexes: [], categoryPartIndex: 0, blockIndexes: [0] },
    ]) {
      expect(merchantAnalysisResultSchema.safeParse({ ...output, nativeRuleSets: [expression] }).success).toBe(false);
    }
    for (const blockIndexes of [[], [0, 0], [1, 0], [-1], [0.5], ['0'], [2], [4294967296], null]) {
      expect(merchantAnalysisResultSchema.safeParse({
        ...output, nativeRuleParts: [{ blockIndexes }, ...output.nativeRuleParts.slice(1)],
      }).success).toBe(false);
    }
    const missing: Record<string, unknown> = { ...output };
    delete missing.nativeRuleParts;
    expect(merchantAnalysisResultSchema.safeParse(missing).success).toBe(false);
    expect(merchantAnalysisResultSchema.safeParse({
      ...output,
      nativeRuleSets: [...output.nativeRuleSets, { orPartIndexes: [], andPartIndexes: [], categoryPartIndex: 0 }],
    }).success).toBe(false);
  });
  it('canonicalizes empty AND operands only after validating original reference closure and order', () => {
    const output = extendedResult();
    const expression = { orPartIndexes: [0], andPartIndexes: [[], [0], [0], [0]], categoryPartIndex: 0 };
    const canonical = { ...output, nativeRuleSets: [{ ...expression, andPartIndexes: [] }] };
    expect(merchantAnalysisResultSchema.parse({ ...output, nativeRuleSets: [expression] })).toEqual(canonical);
    expect(validateNativeRuleTables(output.nativeRuleBlocks, output.nativeRuleParts, [expression], [0]).nativeRuleSets)
      .toEqual(canonical.nativeRuleSets);
    for (const andPartIndexes of [
      [[], [1], [0], [0]], [[], [0, 0], [0], [0]], [[], [-1], [0], [0]],
      [[], [0]], [[], [0], [0]], [[], [0, 1, 2], [0], [0]],
    ]) {
      expect(merchantAnalysisResultSchema.safeParse({
        ...output, nativeRuleSets: [{ ...expression, andPartIndexes }],
      }).success).toBe(false);
    }
  });
  it('preserves generic legacy ID widths and source counts without merchant-only caps', () => {
    const parts = [{ blockIndexes: [0] }];
    const sets = [{ orPartIndexes: [0], andPartIndexes: [], categoryPartIndex: 0 }];
    for (const ruleIds of [
      ['x'.repeat(300)],
      Array.from({ length: 100001 }, (_, index) => `legacy-${String(index).padStart(6, '0')}`),
    ]) {
      const blocks = [{ ruleIds }];
      expect(validateNativeRuleTables(blocks, parts, sets, [0])).toEqual({
        nativeRuleBlocks: blocks, nativeRuleParts: parts, nativeRuleSets: sets,
      });
      expect(merchantAnalysisResultSchema.safeParse({
        ...fixture.result as Record<string, unknown>,
        nativeRuleBlocks: blocks, nativeRuleParts: parts, nativeRuleSets: sets,
        nativeRuleClassifications: [{
          transactionId: 'tx-source', accountId: 'account-checking', categoryId: 'category-bills', ruleSetIndex: 0,
        }],
      }).success).toBe(false);
    }
    const blockIndexes = Array.from({ length: 100001 }, (_, index) => index);
    expect(nativeRulePartSchema.parse({ blockIndexes })).toEqual({ blockIndexes });
  });
  it('bounds literal witness work for cheap OR and cheap category-selected AND without a blanket branch order', () => {
    const blocks = Array.from({ length: 128 }, (_, index) => ({
      ruleIds: index === 0 ? ['witness-000', 'witness-000-extra'] : [`witness-${String(index).padStart(3, '0')}`],
    }));
    const cases = [
      {
        parts: [
          Array.from({ length: 128 }, (_, index) => index), Array.from({ length: 64 }, (_, index) => index),
          Array.from({ length: 32 }, (_, index) => index + 96), Array.from({ length: 32 }, (_, index) => index + 64),
          Array.from({ length: 64 }, (_, index) => index + 64), ...Array.from({ length: 64 }, (_, index) => [index]),
        ],
        sets: Array.from({ length: 64 }, (_, index) => ({
          orPartIndexes: [1, index + 5], andPartIndexes: [[2], [4], [3], [4]], categoryPartIndex: 0,
        })),
        expectedIds: [...Array.from({ length: 64 }, (_, index) => `witness-${String(index).padStart(3, '0')}`), 'witness-000-extra'].sort(),
      },
      {
        parts: [
          Array.from({ length: 64 }, (_, index) => index + 64), Array.from({ length: 64 }, (_, index) => index),
          ...Array.from({ length: 64 }, (_, index) => [index + 64]),
        ],
        sets: Array.from({ length: 64 }, (_, index) => ({
          orPartIndexes: [1], andPartIndexes: [[index + 2], [0], [0], [0]], categoryPartIndex: 0,
        })),
        expectedIds: ['witness-064'],
      },
      {
        // Account-A OR category-Ci matches every uncategorized row; the
        // payee/account-B and category-Dj AND postings have no joint witness.
        // There is deliberately no cheap singleton OR posting for this shape.
        parts: [
          Array.from({ length: 128 }, (_, index) => index), Array.from({ length: 64 }, (_, index) => index),
          Array.from({ length: 32 }, (_, index) => index + 96), Array.from({ length: 32 }, (_, index) => index + 64),
          Array.from({ length: 64 }, (_, index) => index + 64), ...Array.from({ length: 32 }, (_, index) => [index + 64]),
        ],
        sets: Array.from({ length: 32 }, (_, index) => ({
          orPartIndexes: [1], andPartIndexes: [[2, index + 5], [4], [2], [3]], categoryPartIndex: 0,
        })),
        expectedIds: [...Array.from({ length: 64 }, (_, index) => `witness-${String(index).padStart(3, '0')}`), 'witness-000-extra'].sort(),
      },
      {
        // Neither first probe succeeds: the third OR candidate belongs to
        // the selected category. Probe-once-then-exhaust must also fail.
        parts: [
          [2, 63, ...Array.from({ length: 64 }, (_, index) => index + 64)],
          Array.from({ length: 64 }, (_, index) => index),
          Array.from({ length: 32 }, (_, index) => index + 96), Array.from({ length: 32 }, (_, index) => index + 64),
          Array.from({ length: 64 }, (_, index) => index + 64), ...Array.from({ length: 32 }, (_, index) => [index + 64]),
        ],
        sets: Array.from({ length: 32 }, (_, index) => ({
          orPartIndexes: [1], andPartIndexes: [[2, index + 5], [4], [2], [3]], categoryPartIndex: 0,
        })),
        expectedIds: ['witness-002', 'witness-063'],
      },
    ];
    const originalSome: (this: unknown[], predicate: (value: unknown, index: number, array: unknown[]) => unknown,
      thisArg?: unknown) => boolean = Array.prototype.some;
    let visits = 0;
    const spy = vi.spyOn(Array.prototype, 'some').mockImplementation(function (
      this: unknown[], predicate: (value: unknown, index: number, array: unknown[]) => unknown, thisArg?: unknown,
    ) {
      return originalSome.call(this, (value, index, array) => {
        if (typeof value === 'number' && array.length >= 32) visits++;
        return predicate.call(thisArg, value, index, array);
      });
    });
    const originalAt: (this: unknown[], index: number) => unknown = Array.prototype.at;
    let atSpy: { mockRestore(): void } | undefined;
    try {
      // Cursor candidate reads remain observable after replacing whole-array
      // some scans; count both forms so an exhaustive-branch regression fails.
      atSpy = vi.spyOn(Array.prototype, 'at').mockImplementation(function (this: unknown[], index: number) {
        const value = originalAt.call(this, index);
        if (typeof value === 'number') visits++;
        return value;
      });
      for (const specimen of cases) {
        visits = 0;
        const parts = specimen.parts.map((blockIndexes) => ({ blockIndexes }));
        const tables = validateNativeRuleTables(blocks, parts, specimen.sets, specimen.sets.map((_, index) => index));
        const sourceMemberships = specimen.parts.reduce((count, indexes) => count + indexes.length, 0);
        expect(visits, 'normalization is source-linear; classified witnesses must not rescan wide disjoint branches')
          .toBeLessThanOrEqual(sourceMemberships + 8 * specimen.sets.length);
        const set = tables.nativeRuleSets[0];
        const union = (references: number[]) => new Set(references.flatMap((index) => tables.nativeRuleParts[index].blockIndexes));
        const matched = union(set.orPartIndexes);
        const operands = set.andPartIndexes.map(union);
        if (operands.length) for (const block of operands[0]) {
          if (operands.every((operand) => operand.has(block))) matched.add(block);
        }
        const category = union([set.categoryPartIndex]);
        const ids = [...matched].filter((block) => category.has(block)).flatMap((block) => tables.nativeRuleBlocks[block].ruleIds).sort();
        expect(ids).toEqual(specimen.expectedIds);
      }
    } finally {
      atSpy?.mockRestore();
      spy.mockRestore();
    }
  });
});

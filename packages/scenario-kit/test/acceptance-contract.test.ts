import { describe, expect, it } from 'vitest';

import { listScenarios } from '../src/catalog.js';
import {
  SCENARIO_ACCEPTANCE_CONTRACT,
  createScenarioRecordCollector,
  verifyScenarioCoverage,
} from '../src/acceptance-contract.js';

// Approved scope is intentionally independent of the live catalog and runner manifest.
const APPROVED_ACCEPTANCE_CONTRACT: Readonly<Record<string, readonly string[]>> = {
  'funded-purchase': [],
  'guilt-free-spending': [],
  'unfunded-category': [],
  'donor-reallocation': [],
  'protected-category': [],
  'goal-category': [],
  'donor-competition': [],
  'future-assignment': [],
  'account-transfer': [],
  'transfer-too-late': [],
  'credit-card-purchase': [],
  'missing-account-evidence': [],
  'expired-account-evidence': [],
  'currency-mismatch': [],
  'pending-debit': [],
  'uncategorized-debit': [],
  'reservation-block': [],
  'reservation-inform': [],
  'commitment-overlap': [],
  'rich-cart': [],
  'required-item-overage': [],
  'outside-price': [],
  'expired-session': [],
  'split-completion': [],
  'cooldown-completion': [],
  'coapproval-completion': [
    'coapproval.scoped-proposal-visible-private-session-denied',
    'coapproval.requester-excluded-independent-human-approvals-retained',
    'coapproval.peer-execution-denied-owner-native-debit',
    'coapproval-audit',
  ],
  'import-before-completion': [],
  'import-after-completion': [],
  'ambiguous-completion': [],
  'governance-scoped-access': ['scoped-access', 'grant-change', 'revoked-membership'],
  'governance-invitation-lifecycle': ['pending-invitation', 'invitation-redemption', 'membership-rejoin'],
  'governance-delegated-assistant': ['assistant-allow-deny', 'delegation-revocation'],
  'merchant-local-sparse': ['sparse-inference'],
  'merchant-local-insufficient': ['insufficient-evidence'],
  'merchant-alias-conflict': ['conflicting-source', 'alias-confirm', 'alias-reject', 'correction-precedence'],
  'merchant-recurrence-calendar': ['recurrence-calendar', 'pattern-confirm', 'pattern-reject', 'calendar-unknown'],
  'merchant-native-rule-lifecycle': ['native-rule-execution', 'native-future-import', 'stale-native-proposal'],
  'merchant-research-success': ['research-consent', 'research-cache', 'research-expiry'],
  'merchant-research-outage': ['research-outage'],
  'merchant-research-lifecycle': [
    'research-policy-revocation',
    'research-policy-revocation-installation',
    'research-policy-revocation-space',
    'research-policy-revocation-budget',
    'research-grant-revocation',
    'research-daily-limit',
    'research-monthly-limit',
    'research-delete-fence',
    'research-clock-controls',
    'held-reset',
  ],
};

// Structural collector/checker inputs, not simulated financial or provider results.
function record(scenarioId: string, branches: readonly string[] = []) {
  return {
    type: 'scenario-verification',
    catalogVersion: '1',
    scenarioId,
    anchor: '2026-09-06T12:00:00.000Z',
    status: 'passed',
    assertions: { name: `${scenarioId} ${branches.join(' ') || 'native behavior'}`, count: 1 },
    evidence: { backend: 'disposable-actual', auth: 'better-auth' },
    branches,
  };
}

const completeRecords = () => Object.entries(APPROVED_ACCEPTANCE_CONTRACT)
  .map(([id, branches]) => record(id, branches));

function collect(chunks: readonly string[]): readonly unknown[] {
  const collector = createScenarioRecordCollector();
  for (const chunk of chunks) collector.write(chunk);
  return collector.finish();
}

const selected = { 'funded-purchase': [] };

describe('independent approved scenario coverage', () => {
  it('retains every approved ID and named branch even if a catalog-derived scope would omit it', () => {
    expect(SCENARIO_ACCEPTANCE_CONTRACT).toEqual(APPROVED_ACCEPTANCE_CONTRACT);
    const catalogIds = listScenarios().map(({ id }) => id);
    for (const id of Object.keys(APPROVED_ACCEPTANCE_CONTRACT)) expect(catalogIds).toContain(id);
    for (const id of catalogIds) expect(SCENARIO_ACCEPTANCE_CONTRACT).toHaveProperty(id);
  });

  it('accepts complete coverage and collects independently asserted branches across runs of the same story', () => {
    expect(() => verifyScenarioCoverage(completeRecords(), APPROVED_ACCEPTANCE_CONTRACT)).not.toThrow();
    const independentlyRun = Object.entries(APPROVED_ACCEPTANCE_CONTRACT).flatMap(([id, branches]) =>
      branches.length ? branches.map((branch) => record(id, [branch])) : [record(id)]);
    expect(() => verifyScenarioCoverage(independentlyRun, APPROVED_ACCEPTANCE_CONTRACT)).not.toThrow();
    expect(() => verifyScenarioCoverage([record('funded-purchase')], selected)).not.toThrow();
  });

  it.each(Object.keys(APPROVED_ACCEPTANCE_CONTRACT))('rejects zero-exit coverage missing approved story %s', (id) => {
    const records = completeRecords().filter((entry) => entry.scenarioId !== id);
    expect(() => verifyScenarioCoverage(records, APPROVED_ACCEPTANCE_CONTRACT)).toThrow();
  });

  it.each(Object.entries(APPROVED_ACCEPTANCE_CONTRACT).flatMap(([id, branches]) =>
    branches.map((branch) => ({ id, branch }))))('rejects missing $id branch $branch despite other successful assertions', ({ id, branch }) => {
    const records = completeRecords().map((entry) => entry.scenarioId === id
      ? { ...entry, branches: entry.branches.filter((value) => value !== branch) }
      : entry);
    expect(() => verifyScenarioCoverage(records, APPROVED_ACCEPTANCE_CONTRACT)).toThrow();
  });

  it('does not replace a missing scenario with duplicate successes or an unrelated scenario', () => {
    const records = completeRecords().filter((entry) => entry.scenarioId !== 'merchant-local-sparse');
    records.push(record('funded-purchase'), record('not-approved', ['sparse-inference']));
    expect(() => verifyScenarioCoverage(records, APPROVED_ACCEPTANCE_CONTRACT)).toThrow();
  });

  it('rejects an empty expected contract instead of silently skipping an unmapped selected story', () => {
    expect(() => verifyScenarioCoverage([record('funded-purchase')], {})).toThrow();
  });

  it('does not borrow another scenario branch or a failed/zero-assertion record', () => {
    const required = { 'merchant-native-rule-lifecycle': ['stale-native-proposal'] };
    const stale = record('merchant-native-rule-lifecycle', ['stale-native-proposal']);
    for (const wrongEvidence of [
      record('merchant-alias-conflict', ['stale-native-proposal']),
      { ...stale, status: 'failed' },
      { ...stale, assertions: { ...stale.assertions, count: 0 } },
      { ...stale, assertions: { ...stale.assertions, name: '' } },
      { ...stale, branches: 'stale-native-proposal' },
      { ...stale, branches: [null, 1, { branch: 'stale-native-proposal' }] },
    ]) {
      expect(() => verifyScenarioCoverage([record('merchant-native-rule-lifecycle'), wrongEvidence], required)).toThrow();
    }
  });

  const valid = record('funded-purchase');
  it.each([
    { reason: 'no record', records: [] },
    { reason: 'unrelated scenario', records: [record('merchant-local-sparse')] },
    { reason: 'fault instead of scenario', records: [{ ...valid, type: 'fault-verification' }] },
    { reason: 'failed assertions', records: [{ ...valid, status: 'failed' }] },
    { reason: 'absent assertions', records: [{ ...valid, assertions: undefined }] },
    { reason: 'unnamed assertions', records: [{ ...valid, assertions: { count: 1 } }] },
    { reason: 'blank assertion name', records: [{ ...valid, assertions: { name: '  ', count: 1 } }] },
    { reason: 'zero assertions', records: [{ ...valid, assertions: { name: valid.assertions.name, count: 0 } }] },
    { reason: 'negative assertions', records: [{ ...valid, assertions: { name: valid.assertions.name, count: -1 } }] },
    { reason: 'fractional assertions', records: [{ ...valid, assertions: { name: valid.assertions.name, count: 0.5 } }] },
    { reason: 'unsafe assertion count', records: [{ ...valid, assertions: { name: valid.assertions.name, count: Number.MAX_SAFE_INTEGER + 1 } }] },
    { reason: 'string assertion count', records: [{ ...valid, assertions: { name: valid.assertions.name, count: '1' } }] },
    { reason: 'mock backend', records: [{ ...valid, evidence: { ...valid.evidence, backend: 'mock' } }] },
    { reason: 'bypassed auth', records: [{ ...valid, evidence: { ...valid.evidence, auth: 'bypass' } }] },
    { reason: 'absent evidence', records: [{ ...valid, evidence: undefined }] },
    { reason: 'unsupported catalog version', records: [{ ...valid, catalogVersion: 'not-approved' }] },
    { reason: 'absent anchor', records: [{ ...valid, anchor: undefined }] },
    { reason: 'invalid anchor', records: [{ ...valid, anchor: 'not-a-date' }] },
    { reason: 'unstructured JSON', records: [null, [], 'passed', 1] },
  ])('rejects selected verification with $reason even if Vitest exits zero', ({ records }) => {
    expect(() => verifyScenarioCoverage(records, selected)).toThrow();
  });
});

describe('bounded plain-JSON scenario child collection', () => {
  it('retains records split at arbitrary chunk boundaries, CRLF and final unterminated lines', () => {
    const first = record('funded-purchase');
    const second = record('merchant-native-rule-lifecycle', ['native-future-import']);
    const text = `${JSON.stringify(first)}\r\n${JSON.stringify(second)}`;
    expect(collect([...text])).toEqual([first, second]);
  });

  it('ignores unrelated output, malformed JSON, fault records and ANSI-decorated non-record lines', () => {
    const valid = record('funded-purchase');
    const records = collect([
      '\u001b[32m RUN \u001b[0m\nnormal Actual startup output\n',
      '{"type":"scenario-verification",broken}\n',
      `${JSON.stringify({ type: 'fault-verification', status: 'passed' })}\n`,
      `${JSON.stringify({ type: 'unrelated', scenarioId: 'funded-purchase' })}\n`,
      `${JSON.stringify(valid)}\n`,
    ]);
    expect(records).toEqual([valid]);
  });

  it('cannot convert malformed, unrelated or decorated JSON into selected scenario success', () => {
    for (const text of [
      '{"type":"scenario-verification",broken}\n',
      `${JSON.stringify(record('merchant-local-sparse'))}\n`,
      `\u001b[32m${JSON.stringify(record('funded-purchase'))}\u001b[0m\n`,
    ]) {
      expect(() => verifyScenarioCoverage(collect([text]), selected)).toThrow();
    }
  });

  it('discards oversized record lines and large irrelevant stdout without retaining or parsing their contents, then recovers at newline', () => {
    const collector = createScenarioRecordCollector();
    // More than 16KiB is never a verification line, including a plausible JSON prefix.
    collector.write('{"type":"scenario-verification","irrelevant":"');
    for (let index = 0; index < 128; index += 1) collector.write('x'.repeat(8_192));
    collector.write(`","scenarioId":"funded-purchase"}\n${'y'.repeat(1_048_576)}`);
    collector.write(`\n${JSON.stringify({ ...record('funded-purchase'), assertions: { name: 'x'.repeat(17_000), count: 1 } })}\n`);
    const valid = record('merchant-local-sparse', ['sparse-inference']);
    collector.write(`${JSON.stringify(valid)}\n`);
    expect(collector.finish()).toEqual([valid]);
  });

  it('caps retained records at 1000 and fails explicitly on overflow instead of silently truncating coverage', () => {
    const line = `${JSON.stringify(record('funded-purchase'))}\n`;
    const atLimit = collect(Array.from({ length: 1_000 }, () => line));
    expect(atLimit).toHaveLength(1_000);
    expect(() => collect(Array.from({ length: 1_001 }, () => line))).toThrow();
  });

  it('does not promote zero assertions merely because the line parses', () => {
    const invalid = { ...record('funded-purchase'), assertions: { name: 'funded-purchase', count: 0 } };
    expect(() => verifyScenarioCoverage(collect([JSON.stringify(invalid)]), selected)).toThrow();
  });
});

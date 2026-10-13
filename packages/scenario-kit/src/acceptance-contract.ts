import { z } from 'zod';

// Approved acceptance scope is independent of catalog-derived display counts.
export const SCENARIO_ACCEPTANCE_CONTRACT: Readonly<Record<string, readonly string[]>> = {
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

const verificationRecordSchema = z.object({
  type: z.literal('scenario-verification'),
  catalogVersion: z.literal('1'),
  scenarioId: z.string().min(1),
  anchor: z.string().datetime(),
  status: z.literal('passed'),
  assertions: z.object({
    name: z.string().trim().min(1),
    count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }),
  evidence: z.object({ backend: z.literal('disposable-actual'), auth: z.literal('better-auth') }),
  branches: z.array(z.string().min(1)).optional(),
});

/** Only successful named native/authenticated assertions contribute story or branch coverage. */
export function verifyScenarioCoverage(
  records: readonly unknown[],
  expected: Readonly<Record<string, readonly string[]>>,
): void {
  const expectedEntries = Object.entries(expected);
  if (expectedEntries.length === 0) throw new Error('Scenario verification requires a nonempty acceptance contract');
  const covered = new Map<string, Set<string>>();
  for (const record of records) {
    const parsed = verificationRecordSchema.safeParse(record);
    if (!parsed.success || !Object.hasOwn(expected, parsed.data.scenarioId)) continue;
    let branches = covered.get(parsed.data.scenarioId);
    if (!branches) {
      branches = new Set<string>();
      covered.set(parsed.data.scenarioId, branches);
    }
    for (const branch of parsed.data.branches ?? []) branches.add(branch);
  }
  const missing: string[] = [];
  for (const [id, requiredBranches] of expectedEntries) {
    if (!Object.hasOwn(SCENARIO_ACCEPTANCE_CONTRACT, id) || !Array.isArray(requiredBranches)) {
      throw new Error('Scenario verification encountered an unregistered acceptance contract');
    }
    const branches = covered.get(id);
    if (!branches) missing.push(id);
    else for (const branch of requiredBranches) if (!branches.has(branch)) missing.push(`${id}:${branch}`);
  }
  if (missing.length) throw new Error(`Missing successful scenario verification: ${missing.join(', ')}`);
}

const MAX_LINE_BYTES = 16 * 1024;
const MAX_RECORDS = 1000;

/** Collect plain JSON only; oversized diagnostic lines never accumulate or reach JSON.parse. */
export function createScenarioRecordCollector(): {
  write(chunk: string): void;
  finish(): readonly unknown[];
} {
  const records: unknown[] = [];
  let pending = '';
  let pendingBytes = 0;
  let discardLine = false;
  let overflow = false;

  function readLine(): void {
    if (discardLine || !pending.startsWith('{')) return;
    let record: unknown;
    try {
      record = JSON.parse(pending) as unknown;
    } catch {
      // Ordinary child diagnostics and malformed JSON are not verification evidence.
      return;
    }
    if (typeof record !== 'object' || record === null || !('type' in record)
      || record.type !== 'scenario-verification') return;
    if (records.length === MAX_RECORDS) {
      overflow = true;
      throw new Error('Scenario verification record limit exceeded');
    }
    records.push(record);
  }

  return {
    write(chunk) {
      if (overflow) throw new Error('Scenario verification record limit exceeded');
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf('\n', offset);
        const end = newline < 0 ? chunk.length : newline;
        if (!discardLine) {
          if (pending.length + end - offset > MAX_LINE_BYTES) discardLine = true;
          else {
            const fragment = chunk.slice(offset, end);
            const bytes = Buffer.byteLength(fragment, 'utf8');
            if (pendingBytes + bytes > MAX_LINE_BYTES) discardLine = true;
            else {
              pending += fragment;
              pendingBytes += bytes;
            }
          }
          if (discardLine) {
            pending = '';
            pendingBytes = 0;
          }
        }
        if (newline < 0) break;
        readLine();
        pending = '';
        pendingBytes = 0;
        discardLine = false;
        offset = newline + 1;
      }
    },
    finish() {
      if (overflow) throw new Error('Scenario verification record limit exceeded');
      readLine();
      pending = '';
      pendingBytes = 0;
      discardLine = false;
      return records;
    },
  };
}

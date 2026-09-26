import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [liquidityPath, foundationPath] = process.argv.slice(2);
if (!liquidityPath || !foundationPath) {
  throw new Error(
    'Usage: node test/decision-card.mjs <account-aware-liquidity.json> <financial-decision-foundation.json>',
  );
}

const here = path.dirname(fileURLToPath(import.meta.url));
const native = createRequire(import.meta.url)(path.resolve(here, '..', 'balanceframe.node'));
const readFixture = (fixturePath) =>
  JSON.parse(readFileSync(path.resolve(process.cwd(), fixturePath), 'utf8'));

const liquidity = readFixture(liquidityPath);
const foundation = readFixture(foundationPath);

// Keep this boundary fixture in lockstep with the canonical Rust decision-card
// fixture builder. The two source fixtures are composed in memory; no fixture
// files are generated or checked in for this native smoke.
const snapshot = structuredClone(foundation.full);
snapshot.snapshotId = liquidity.snapshotId;
snapshot.contentHash = liquidity.contentHash;
snapshot.capturedAt = liquidity.evaluatedAt;
snapshot.liquidity = structuredClone(liquidity.facts);
snapshot.coverage.accounts = 'complete';
snapshot.coverage.categories = 'complete';
snapshot.coverage.transactions = 'complete';
snapshot.coverage.schedules = 'complete';
snapshot.coverage.budgets = 'complete';
snapshot.legacySnapshot.accounts = [];
snapshot.legacySnapshot.transactions = [];
snapshot.legacySnapshot.categories = [];
snapshot.legacySnapshot.budgets = [];
snapshot.legacySnapshot.schedules = [];

snapshot.observations = [
  {
    kind: 'account_freshness',
    scope: { kind: 'account', id: 'checking' },
    state: 'fresh',
    observedAt: liquidity.evaluatedAt,
    evidence: [
      {
        evidenceId: 'checking-freshness',
        kind: 'bank_sync',
        authorized: true,
        redaction: 'visible',
      },
    ],
  },
];

const context = structuredClone(foundation.claims.context);
context.evaluatedAt = liquidity.evaluatedAt;
context.horizon = structuredClone(liquidity.horizon);
context.snapshotId = liquidity.snapshotId;
context.contentHash = liquidity.contentHash;
context.policyVersion = liquidity.liquidityPolicy.version;
context.policyHash = liquidity.liquidityPolicy.policyHash;
context.policy.maxBudgetSnapshotAgeMinutes = liquidity.maxBudgetSnapshotAgeMinutes;
context.policy.maxBankSyncAgeMinutes = null;

const item = {
  ...structuredClone(liquidity.scenario.items[0]),
  priority: 'planned',
};
const money = (minorUnits) => ({ minorUnits: String(minorUnits), currency: 'USD' });
const request = {
  financialSnapshot: snapshot,
  context,
  liquidityPolicy: structuredClone(liquidity.liquidityPolicy),
  claimSet: structuredClone(liquidity.claimSet),
  priorAllocation: null,
  items: [item],
  categoryPolicies: [
    {
      categoryId: item.categoryId,
      kind: 'ordinary',
      donorEligible: false,
      minimumRetained: money(0),
      projectedRemainingNeed: money(0),
    },
  ],
  validUntil: liquidity.validUntil,
  requestId: 'request-card-1',
  correlationId: 'correlation-card-1',
  decisionId: 'decision-card-1',
};

assert.equal(typeof native.evaluateDecisionCard, 'function');
const evaluate = (value) => JSON.parse(native.evaluateDecisionCard(JSON.stringify(value)));
const card = evaluate(request);

assert.equal(card.version, '1');
assert.equal(card.decisionId, request.decisionId);
assert.equal(card.requestId, request.requestId);
assert.equal(card.correlationId, request.correlationId);
assert.equal(card.snapshotId, liquidity.snapshotId);
assert.equal(card.contentHash, liquidity.contentHash);
assert.equal(card.policyVersion, liquidity.liquidityPolicy.version);
assert.equal(card.policyHash, liquidity.liquidityPolicy.policyHash);
assert.equal(card.claimSetRevision, liquidity.claimSet.revision);
assert.match(card.planHash, /^[0-9a-f]{64}$/);

assert.equal(card.outcome, 'safe_after_date');
assert.equal(card.budgetFundingStatus, 'funded');
assert.equal(card.paymentLiquidityStatus, 'transfer_required');
assert.equal(card.selectedAccountId, 'checking');
assert.equal(card.selectionSource, 'explicit');

const stateCategory = (state, categoryId) => {
  const category = state?.categories?.find(({ categoryId: id }) => id === categoryId);
  assert.ok(category, `decision card state must contain category ${categoryId}`);
  return category;
};
const stateAccount = (state, accountId) => {
  const account = state?.accounts?.find(({ accountId: id }) => id === accountId);
  assert.ok(account, `decision card state must contain account ${accountId}`);
  return account;
};

const beforeFood = stateCategory(card.before, item.categoryId);
const afterFood = stateCategory(card.after, item.categoryId);
assert.equal(beforeFood.availability.minorUnits, '2000');
assert.equal(afterFood.availability.minorUnits, '0');
assert.equal(beforeFood.uncommittedAvailability.minorUnits, '2000');
assert.equal(afterFood.uncommittedAvailability.minorUnits, '0');

const beforeChecking = stateAccount(card.before, 'checking');
const afterChecking = stateAccount(card.after, 'checking');
assert.equal(beforeChecking.recordedBalance.minorUnits, '9000');
assert.equal(afterChecking.recordedBalance.minorUnits, '9000');
assert.equal(beforeChecking.adjustedCash.minorUnits, '9000');
assert.equal(afterChecking.adjustedCash.minorUnits, '10000');
assert.notDeepEqual(card.before, card.after);

assert.equal(card.items.length, 1);
assert.equal(card.items[0].id, item.id);
assert.equal(card.items[0].categoryId, item.categoryId);
assert.equal(card.items[0].outcome, 'safe_after_date');
assert.equal(card.items[0].before.recordedBalance.minorUnits, '9000');
assert.equal(card.items[0].after.recordedBalance.minorUnits, '9000');

const repeated = evaluate(request);
assert.equal(repeated.planHash, card.planHash);
const changedRevision = structuredClone(request);
changedRevision.claimSet.revision = 'claims-2';
const changed = evaluate(changedRevision);
assert.equal(changed.claimSetRevision, 'claims-2');
assert.notEqual(changed.planHash, card.planHash);

assert.throws(() => native.evaluateDecisionCard('{not-json'));
for (const identity of ['requestId', 'correlationId', 'decisionId']) {
  const missingIdentity = structuredClone(request);
  delete missingIdentity[identity];
  assert.throws(() => native.evaluateDecisionCard(JSON.stringify(missingIdentity)), identity);
}

console.log('native decision card boundary contract passed');

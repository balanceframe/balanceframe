import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const native = createRequire(import.meta.url)(path.resolve(here, '..', 'balanceframe.node'));
const readFixture = (name) => JSON.parse(readFileSync(path.resolve(repo, 'protocol', 'fixtures', name), 'utf8'));
const liquidity = readFixture('account-aware-liquidity.json');
const foundation = readFixture('financial-decision-foundation.json');
const actionFixture = readFixture('consequential-action.json');
const evaluatedAt = '2026-09-06T10:00:00Z';
const purchaseAt = '2026-09-06T12:00:00Z';
const money = (minorUnits, currency = 'USD') => ({ minorUnits: String(minorUnits), currency });

// Keep this source composer identical to the canonical DecisionCard test composer.
function decisionCardRequest() {
  const snapshot = structuredClone(foundation.full);
  snapshot.snapshotId = liquidity.snapshotId;
  snapshot.contentHash = liquidity.contentHash;
  snapshot.capturedAt = evaluatedAt;
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
  snapshot.observations = [{
    kind: 'account_freshness',
    scope: { kind: 'account', id: 'checking' },
    state: 'fresh',
    observedAt: evaluatedAt,
    evidence: [{ evidenceId: 'checking-freshness', kind: 'bank_sync', authorized: true, redaction: 'visible' }],
  }];
  snapshot.observations.push(structuredClone(actionFixture.sourceObservation));
  const checking = snapshot.liquidity.accounts.find((account) => account.accountId === 'checking');
  assert.ok(checking, 'canonical checking facts exist');
  checking.recordedBalance = money(13_000);
  snapshot.liquidity.categories[0].availability = money(0);
  const reserve = structuredClone(snapshot.liquidity.categories[0]);
  reserve.categoryId = 'reserve';
  reserve.cashBucketId = 'reserve';
  reserve.availability = money(6_000);
  const reserveTwo = structuredClone(reserve);
  reserveTwo.categoryId = 'reserve-two';
  reserveTwo.cashBucketId = 'reserve-two';
  snapshot.liquidity.categories.push(reserve, reserveTwo);

  const context = structuredClone(foundation.claims.context);
  context.evaluatedAt = liquidity.evaluatedAt;
  context.horizon = structuredClone(liquidity.horizon);
  context.snapshotId = liquidity.snapshotId;
  context.contentHash = liquidity.contentHash;
  context.policyVersion = liquidity.liquidityPolicy.version;
  context.policyHash = liquidity.liquidityPolicy.policyHash;
  context.policy.maxBudgetSnapshotAgeMinutes = liquidity.maxBudgetSnapshotAgeMinutes;
  context.policy.maxBankSyncAgeMinutes = null;
  const item = { ...structuredClone(liquidity.scenario.items[0]), priority: 'planned' };
  item.purchaseAt = purchaseAt;
  item.requiredBy = purchaseAt;
  return {
    financialSnapshot: snapshot,
    context,
    liquidityPolicy: structuredClone(liquidity.liquidityPolicy),
    claimSet: structuredClone(liquidity.claimSet),
    priorAllocation: null,
    items: [item],
    categoryPolicies: [
      { categoryId: 'food', kind: 'ordinary', donorEligible: false, minimumRetained: money(0), projectedRemainingNeed: money(0) },
      { categoryId: 'reserve', kind: 'ordinary', donorEligible: true, minimumRetained: money(1_000), projectedRemainingNeed: money(2_000) },
      { categoryId: 'reserve-two', kind: 'ordinary', donorEligible: false, minimumRetained: money(1_000), projectedRemainingNeed: money(2_000) },
    ],
    validUntil: liquidity.validUntil,
    requestId: 'request-consequential-action-1',
    correlationId: 'correlation-consequential-action-1',
    decisionId: 'decision-consequential-action-1',
  };
}

function actionRequest(intent = actionFixture.intent) {
  return {
    decisionCardRequest: decisionCardRequest(),
    intent: structuredClone(intent),
    currentLedger: structuredClone(actionFixture.currentLedger),
    resolvedEvidence: structuredClone(actionFixture.resolvedEvidence),
    supplementalObservations: [],
    financialPolicyVersion: actionFixture.financialPolicyVersion,
    evaluatedAt: actionFixture.evaluatedAt,
    idempotencyKey: actionFixture.idempotencyKey,
  };
}

function fundFood(request) {
  request.currentLedger.assignments.find((assignment) => assignment.categoryId === 'food').amount = money(2_000);
  request.decisionCardRequest.financialSnapshot.liquidity.categories
    .find((category) => category.categoryId === 'food').availability = money(2_000);
  return request;
}

function alternateDonorRequest() {
  const request = actionRequest(actionFixture.alternateDonorIntent);
  for (const eligibility of actionFixture.alternateDonorEligibility) {
    request.decisionCardRequest.categoryPolicies
      .find((policy) => policy.categoryId === eligibility.categoryId).donorEligible = eligibility.donorEligible;
  }
  return request;
}

function evidenceProjectionRequest() {
  const request = fundFood(actionRequest(actionFixture.evidenceProjectionIntent));
  request.decisionCardRequest.items[0].amount = {
    minorUnits: (-BigInt(request.intent.transaction.amount.minorUnits)).toString(),
    currency: request.intent.transaction.amount.currency,
  };
  return request;
}

const manualRequest = (intent) => {
  const request = fundFood(actionRequest(intent));
  const transaction = intent.transaction;
  const item = request.decisionCardRequest.items[0];
  item.amount = {
    minorUnits: (-BigInt(transaction.amount.minorUnits)).toString(),
    currency: transaction.amount.currency,
  };
  if (transaction.splits.length) {
    item.categoryAllocations = transaction.splits.map((split) => ({
      categoryId: split.categoryId,
      amount: {
        minorUnits: (-BigInt(split.amount.minorUnits)).toString(),
        currency: split.amount.currency,
      },
    }));
  }
  return request;
};

const planAction = (request) => JSON.parse(native.planConsequentialAction(JSON.stringify(request)));
const verifyAction = (plan, request, phase) => JSON.parse(native.verifyConsequentialAction(JSON.stringify({
  plan,
  phase,
  decisionCardRequest: request.decisionCardRequest,
  currentLedger: request.currentLedger,
  resolvedEvidence: request.resolvedEvidence,
  financialPolicyVersion: request.financialPolicyVersion,
  evaluatedAt: request.evaluatedAt,
})));
const isHash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const manual = (amount, splits = []) => ({
  parentId: 'manual-parent-1',
  correlationId: 'manual-correlation-1',
  accountId: 'checking',
  amount: money(amount),
  date: '2026-09-06',
  categoryId: splits.length === 0 ? 'food' : null,
  payeeName: 'Local shop',
  notes: null,
  splits,
});

assert.equal(typeof native.planConsequentialAction, 'function');
assert.equal(typeof native.verifyConsequentialAction, 'function');

const input = actionRequest();
const planned = planAction(input);
assert.equal(planned.version, '1');
assert.deepEqual(planned.action, input.intent);
assert.equal(planned.idempotencyKey, input.idempotencyKey);
assert.equal(planned.expiresAt, input.decisionCardRequest.validUntil);
assert.ok(isHash(planned.actionHash));
assert.ok(isHash(planned.source.preconditionsHash));
assert.ok(isHash(planned.source.invariantsHash));
assert.equal(planAction(input).actionHash, planned.actionHash, 'same request produces a deterministic native hash');
assert.ok(planned.reasonCodes.includes('safe_reallocation'));
const tradeoff = planned.impacts.find((impact) => impact.kind === 'category_reallocation');
assert.deepEqual(
  {
    source: tradeoff.sourceCategoryId,
    destination: tradeoff.destinationCategoryId,
    amount: tradeoff.amount.minorUnits,
    sourceProtected: tradeoff.sourceProtected,
    before: tradeoff.sourceAvailabilityBefore.minorUnits,
    after: tradeoff.sourceAvailabilityAfter.minorUnits,
    minimum: tradeoff.minimumRetained.minorUnits,
    remainingNeed: tradeoff.projectedRemainingNeed.minorUnits,
    safeToRedirectAfter: tradeoff.safeToRedirectAfter.minorUnits,
    rationale: tradeoff.rationale,
  },
  {
    source: 'reserve', destination: 'food', amount: '2000', sourceProtected: false,
    before: '6000', after: '4000', minimum: '1000', remainingNeed: '2000',
    rationale: 'donor_category_surplus_redirected',
    safeToRedirectAfter: actionFixture.expectedReallocationImpact.safeToRedirectAfter.minorUnits,
  },
);
assert.ok(planned.expectedPostconditions.some((value) => value.kind === 'assignment' && value.categoryId === 'reserve' && value.amount.minorUnits === '4000'));
assert.ok(planned.expectedPostconditions.some((value) => value.kind === 'assignment' && value.categoryId === 'food' && value.amount.minorUnits === '2000'));
assert.ok(planned.expectedPostconditions.some((value) => value.kind === 'account_balance' && value.accountId === 'checking' && value.balance.minorUnits === '13000'));
assert.deepEqual(planned.evidenceReferences.map((evidence) => evidence.evidenceId), ['checking-freshness']);

assert.deepEqual(verifyAction(planned, input, 'preconditions'), {
  valid: true, reason: null, actionHash: planned.actionHash,
});
const refreshed = structuredClone(input);
refreshed.decisionCardRequest.financialSnapshot.snapshotId = 'snapshot-refreshed';
refreshed.decisionCardRequest.financialSnapshot.contentHash = 'content-refreshed';
refreshed.decisionCardRequest.financialSnapshot.capturedAt = '2026-09-06T10:01:00Z';
refreshed.decisionCardRequest.context.snapshotId = 'snapshot-refreshed';
refreshed.decisionCardRequest.context.contentHash = 'content-refreshed';
refreshed.decisionCardRequest.context.evaluatedAt = '2026-09-06T10:01:00Z';
assert.equal(verifyAction(planned, refreshed, 'preconditions').valid, true, 'capture identity refresh alone is non-material');

const evidenceClockChanged = actionRequest();
evidenceClockChanged.decisionCardRequest.financialSnapshot.observations[0].observedAt = '2026-09-06T09:59:00Z';
assert.equal(verifyAction(planned, evidenceClockChanged, 'preconditions').valid, false);
const evidenceExpiryChanged = actionRequest();
evidenceExpiryChanged.decisionCardRequest.financialSnapshot.liquidity.accounts[0].balanceEvidence.expiresAt = '2026-09-06T09:59:00Z';
assert.equal(verifyAction(planned, evidenceExpiryChanged, 'preconditions').valid, false);
const evidenceContentChanged = actionRequest();
evidenceContentChanged.resolvedEvidence[0].contentHash = 'changed-checking-evidence';
assert.equal(verifyAction(planned, evidenceContentChanged, 'preconditions').reason, 'evidence_changed');
const eventInput = evidenceProjectionRequest();
const eventPlan = planAction(eventInput);
const changedEventVersion = structuredClone(eventInput);
changedEventVersion.resolvedEvidence[1].version = 'fd-resolution/2';
changedEventVersion.decisionCardRequest.financialSnapshot.observations[1].version = 'fd-resolution/2';
assert.notEqual(planAction(changedEventVersion).actionHash, eventPlan.actionHash, 'event evidence version is plan-bound');
assert.equal(verifyAction(eventPlan, changedEventVersion, 'preconditions').valid, false);
const changedEventContent = structuredClone(eventInput);
changedEventContent.resolvedEvidence[1].contentHash = 'fd-transaction-content-2';
changedEventContent.decisionCardRequest.financialSnapshot.observations[1].contentHash = 'fd-transaction-content-2';
assert.notEqual(planAction(changedEventContent).actionHash, eventPlan.actionHash, 'event content is plan-bound');
assert.equal(verifyAction(eventPlan, changedEventContent, 'preconditions').valid, false);

const postRead = structuredClone(input);
postRead.currentLedger.assignments[0].amount = money(2_000);
postRead.currentLedger.assignments[1].amount = money(4_000);
postRead.decisionCardRequest.financialSnapshot.liquidity.categories.find((category) => category.categoryId === 'food').availability = money(2_000);
postRead.decisionCardRequest.financialSnapshot.liquidity.categories.find((category) => category.categoryId === 'reserve').availability = money(4_000);
assert.equal(verifyAction(planned, postRead, 'postconditions').valid, true, 'native derives exact actual assignment readback');
const postExpired = structuredClone(postRead);
postExpired.evaluatedAt = '2026-09-07T18:00:00Z';
assert.equal(verifyAction(planned, postExpired, 'postconditions').valid, true, 'read-only recovery can verify after expiry');
const sameRecordEdit = structuredClone(postRead);
sameRecordEdit.currentLedger.accounts[0].name = 'Externally renamed';
assert.equal(verifyAction(planned, sameRecordEdit, 'postconditions').valid, false);
postRead.currentLedger.assignments[1].amount = money(3_999);
assert.equal(verifyAction(planned, postRead, 'postconditions').reason, 'postcondition_mismatch');

const protectedDonor = actionRequest();
protectedDonor.decisionCardRequest.categoryPolicies[1].kind = 'protected';
assert.throws(() => planAction(protectedDonor));
const floor = actionRequest();
floor.decisionCardRequest.categoryPolicies[1].minimumRetained = money(5_000);
assert.throws(() => planAction(floor));
const cashBuffer = actionRequest();
cashBuffer.decisionCardRequest.liquidityPolicy.accounts[0].protectedBuffer = money(14_000);
assert.throws(() => planAction(cashBuffer));
const currentTargetChanged = actionRequest();
currentTargetChanged.currentLedger.assignments[1].amount = money(5_500);
assert.equal(verifyAction(planned, currentTargetChanged, 'preconditions').valid, false);
const materialSourceChanged = actionRequest();
materialSourceChanged.decisionCardRequest.financialSnapshot.liquidity.accounts[0].recordedBalance = money(12_000);
assert.equal(verifyAction(planned, materialSourceChanged, 'preconditions').reason, 'source_changed');
const policyVersionChanged = actionRequest();
policyVersionChanged.financialPolicyVersion = 'financial-policy-2';
assert.equal(verifyAction(planned, policyVersionChanged, 'preconditions').reason, 'policy_changed');
const pendingTreatmentChanged = actionRequest();
pendingTreatmentChanged.decisionCardRequest.financialSnapshot.inclusionScope.pendingActivity = 'excluded';
assert.equal(verifyAction(planned, pendingTreatmentChanged, 'preconditions').reason, 'source_changed');
const uncategorizedPolicyChanged = actionRequest();
uncategorizedPolicyChanged.decisionCardRequest.context.policy.uncategorizedMode = 'block';
assert.equal(verifyAction(planned, uncategorizedPolicyChanged, 'preconditions').reason, 'source_changed');
const staleFundingPath = actionRequest();
staleFundingPath.decisionCardRequest.categoryPolicies[1].donorEligible = false;
assert.equal(verifyAction(planned, staleFundingPath, 'preconditions').reason, 'source_changed');
const tamperedPlan = structuredClone(planned);
tamperedPlan.actionHash = 'f'.repeat(64);
assert.equal(verifyAction(tamperedPlan, input, 'preconditions').reason, 'invalid_plan');
const staleBankRead = actionRequest();
staleBankRead.decisionCardRequest.financialSnapshot.observations[0].state = 'stale';
staleBankRead.resolvedEvidence[0].state = 'stale';
assert.equal(verifyAction(planned, staleBankRead, 'preconditions').reason, 'evidence_changed');
const fullyFunded = fundFood(actionRequest());
assert.throws(() => planAction(fullyFunded));
const staleBank = actionRequest();
staleBank.decisionCardRequest.financialSnapshot.observations[0].state = 'stale';
staleBank.resolvedEvidence[0].state = 'stale';
assert.throws(() => planAction(staleBank));
const pendingExcluded = actionRequest();
pendingExcluded.decisionCardRequest.financialSnapshot.inclusionScope.pendingActivity = 'excluded';
assert.throws(() => planAction(pendingExcluded));
const uncategorized = actionRequest();
uncategorized.decisionCardRequest.financialSnapshot.legacySnapshot.transactions = [{
  id: 'actual-uncategorized',
  accountId: 'checking',
  date: '2026-09-06',
  payeeId: null,
  payeeName: 'Grocer',
  categoryId: null,
  categoryName: null,
  amount: money(-500),
  cleared: false,
  reconciled: false,
  importedId: 'bank-uncategorized',
  importedPayee: null,
  notes: null,
  tags: [],
  transferAccountId: null,
  subtransactions: [],
}];
uncategorized.currentLedger.transactions = [{
  parentId: 'actual-uncategorized',
  accountId: 'checking',
  amount: money(-500),
  date: '2026-09-06',
  categoryId: null,
  payeeName: 'Grocer',
  notes: null,
  splits: [],
  transferAccountId: null,
}];
uncategorized.decisionCardRequest.context.policy.uncategorizedMode = 'block';
assert.throws(() => planAction(uncategorized));
const creditPaymentDonor = actionRequest();
creditPaymentDonor.decisionCardRequest.financialSnapshot.liquidity.categories
  .find((category) => category.categoryId === 'reserve').kind = 'credit_payment';
assert.throws(() => planAction(creditPaymentDonor));

const manualPlan = planAction(manualRequest({ kind: 'manual_transaction', transaction: manual(-1_000) }));
assert.equal(manualPlan.action.kind, 'manual_transaction');
assert.ok(manualPlan.expectedPostconditions.some((value) => value.kind === 'transaction' && value.parentId === 'manual-parent-1'));
const splitPlan = planAction(manualRequest({
  kind: 'manual_transaction',
  transaction: manual(-1_000, [
    { categoryId: 'food', amount: money(-600) },
    { categoryId: 'reserve', amount: money(-400) },
  ]),
}));
assert.equal(splitPlan.action.transaction.splits.length, 2);
const evidencePlan = planAction(evidenceProjectionRequest());
const eventEvidence = evidencePlan.evidenceReferences.find((value) => value.evidenceId === 'fd-transaction-pending');
assert.ok(eventEvidence);
assert.deepEqual(
  {
    subjectId: eventEvidence.subjectId,
    contentHash: eventEvidence.contentHash,
    version: eventEvidence.version,
  },
  {
    subjectId: 'manual-parent-evidence-1',
    contentHash: 'fd-transaction-pending-content-1',
    version: 'fd-resolution/1',
  },
);
assert.ok(evidencePlan.impacts.some((impact) => impact.kind === 'evidence_resolution' && impact.state === 'resolved'));
const walletPlan = planAction(actionRequest({
  kind: 'wallet_materialization', walletId: 'wallet-new-1', accountName: 'Emergency savings', currency: 'USD',
}));
assert.ok(walletPlan.expectedPostconditions.some((value) => value.kind === 'wallet_mapping'
  && value.walletId === 'wallet-new-1' && value.onBudget === true && value.closed === false
  && value.openingBalance.minorUnits === '0'));
const transferPlan = planAction(actionRequest({
  kind: 'transfer', transferId: 'ledger-transfer-1', correlationId: 'transfer-correlation-1',
  sourceAccountId: 'checking', destinationAccountId: 'savings', amount: money(1_000), date: '2026-09-06',
}));
assert.ok(transferPlan.expectedPostconditions.some((value) => value.kind === 'transfer_ledger_entry' && value.transferId === 'ledger-transfer-1'));
assert.ok(!JSON.stringify(transferPlan).includes('settlement'));

const alternatePlan = planAction(alternateDonorRequest());
assert.equal(alternatePlan.action.assignments[0].sourceCategoryId, 'reserve-two');
assert.equal(alternatePlan.action.assignments[0].destinationCategoryId, 'food');

const composite = actionRequest(actionFixture.compositeIntent);
const compositePlan = planAction(composite);
assert.equal(compositePlan.action.kind, 'composite');
assert.equal(compositePlan.action.actions.length, 2);
const changedComposite = structuredClone(composite);
changedComposite.intent.actions[1].transaction.notes = 'Exact composite purchase';
assert.notEqual(planAction(changedComposite).actionHash, compositePlan.actionHash, 'hash binds every ordered composite atom');
const changedCompositeAmount = structuredClone(composite);
changedCompositeAmount.intent.actions[1].transaction.amount = money(-501);
assert.throws(() => planAction(changedCompositeAmount), /manual_cart_total_mismatch/);

const badId = actionRequest();
badId.intent.assignments[0].sourceCategoryId = 'missing-category';
assert.throws(() => planAction(badId));
const badCurrency = actionRequest();
badCurrency.intent.assignments[0].amount = money(2_000, 'EUR');
assert.throws(() => planAction(badCurrency));
const staleEvidence = evidenceProjectionRequest();
staleEvidence.resolvedEvidence[1].state = 'stale';
assert.throws(() => planAction(staleEvidence));
const staleEventResolution = evidenceProjectionRequest();
staleEventResolution.decisionCardRequest.financialSnapshot.observations[1].state = 'stale';
assert.throws(() => planAction(staleEventResolution));
const unauthorizedEventEvidence = evidenceProjectionRequest();
unauthorizedEventEvidence.decisionCardRequest.financialSnapshot.observations[1].evidence[0].authorized = false;
assert.throws(() => planAction(unauthorizedEventEvidence));
const wrongEventEvidenceKind = evidenceProjectionRequest();
wrongEventEvidenceKind.decisionCardRequest.financialSnapshot.observations[1].evidence[0].kind = 'transaction_resolution';
assert.throws(() => planAction(wrongEventEvidenceKind));
const redactedEventEvidence = evidenceProjectionRequest();
redactedEventEvidence.decisionCardRequest.financialSnapshot.observations[1].evidence[0].redaction = 'redacted';
assert.throws(() => planAction(redactedEventEvidence));
const missingEventEvidence = evidenceProjectionRequest();
missingEventEvidence.decisionCardRequest.financialSnapshot.observations[1].evidence = [];
assert.throws(() => planAction(missingEventEvidence));
const wrongEventSubject = evidenceProjectionRequest();
wrongEventSubject.decisionCardRequest.financialSnapshot.observations[1].scope.id = 'different-parent';
assert.throws(() => planAction(wrongEventSubject));
const mismatchedEventContent = evidenceProjectionRequest();
mismatchedEventContent.resolvedEvidence[1].contentHash = 'different-content';
assert.throws(() => planAction(mismatchedEventContent));
const missingEventVersion = evidenceProjectionRequest();
missingEventVersion.decisionCardRequest.financialSnapshot.observations[1].version = '';
assert.throws(() => planAction(missingEventVersion));
const unknownEventField = evidenceProjectionRequest();
unknownEventField.decisionCardRequest.financialSnapshot.observations[1].unexpected = true;
assert.throws(() => planAction(unknownEventField));
const duplicateEvent = evidenceProjectionRequest();
duplicateEvent.decisionCardRequest.financialSnapshot.observations.push(
  structuredClone(duplicateEvent.decisionCardRequest.financialSnapshot.observations[1]),
);
assert.throws(() => planAction(duplicateEvent));
const mismatchedEventVersion = evidenceProjectionRequest();
mismatchedEventVersion.resolvedEvidence[1].version = 'fd-resolution/2';
assert.throws(() => planAction(mismatchedEventVersion));
const wrongSplitTotal = manualRequest({
  kind: 'manual_transaction', transaction: manual(-1_000, [{ categoryId: 'food', amount: money(-999) }]),
});
assert.throws(() => planAction(wrongSplitTotal));
const overflowSplit = manualRequest({
  kind: 'manual_transaction', transaction: manual(-1_000, [
    { categoryId: 'food', amount: money('-9223372036854775807') },
    { categoryId: 'reserve', amount: money(-2) },
  ]),
});
assert.throws(() => planAction(overflowSplit));
const stalePlan = actionRequest();
stalePlan.evaluatedAt = '2026-09-08T10:00:00Z';
assert.throws(() => planAction(stalePlan));
const manualIdentity = manualRequest({ kind: 'manual_transaction', transaction: manual(-1_000) });
const parentIdentityPlan = planAction(manualIdentity);
manualIdentity.intent.transaction.parentId = 'manual-parent-2';
assert.notEqual(planAction(manualIdentity).actionHash, parentIdentityPlan.actionHash);

console.log('native consequential action boundary contract passed');

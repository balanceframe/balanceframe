import Ajv, { type AnySchemaObject, type ValidateFunction } from 'ajv';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

type JsonObject = Record<string, unknown>;

type MoneyObject = JsonObject & {
  minorUnits: string;
  currency: string;
};

type LiquidityFactsObject = JsonObject & {
  categories: JsonObject[];
};

type ItemObject = JsonObject & {
  id: string;
  categoryId: string;
  amount: MoneyObject;
  priority?: string | number;
  quantity?: unknown;
  categoryAllocations?: JsonObject[];
  barcode?: string;
  priceProvenance?: JsonObject;
  routeSelection: JsonObject;
};

type SnapshotObject = JsonObject & {
  snapshotId: string;
  contentHash: string;
  capturedAt: string;
  coverage: JsonObject;
  legacySnapshot: JsonObject;
  observations: JsonObject[];
  liquidity?: LiquidityFactsObject;
};

type ContextObject = JsonObject & {
  evaluatedAt: string;
  horizon: JsonObject;
  policy: JsonObject;
  policyVersion: string;
  policyHash: string;
  snapshotId: string;
  contentHash: string;
};

type FoundationFixture = {
  full: SnapshotObject;
  claims: { context: ContextObject };
};

type LiquidityFixture = {
  snapshotId: string;
  contentHash: string;
  evaluatedAt: string;
  horizon: JsonObject;
  facts: LiquidityFactsObject;
  liquidityPolicy: JsonObject;
  claimSet: JsonObject;
  scenario: { items: ItemObject[] };
  validUntil: string;
  maxBudgetSnapshotAgeMinutes: number;
};

type CategoryStateObject = JsonObject & {
  asOfMonth: string;
  availability: MoneyObject;
};

type CardStateObject = JsonObject & {
  categories: CategoryStateObject[];
  accounts: JsonObject[];
  goals: JsonObject[];
  obligations: JsonObject[];
  runway: JsonObject;
};

type TransferLegObject = JsonObject & {
  estimatedArrival: string;
};

type TransferPathObject = JsonObject & {
  legs: TransferLegObject[];
};

type CardObject = JsonObject & {
  decisionId: string;
  requestId: string;
  correlationId: string;
  outcome: string;
  planHash: string;
  before: CardStateObject;
  after: CardStateObject | null;
  fundingPaths: TransferPathObject[];
  evidence: JsonObject[];
  items: JsonObject[];
  intentHash: string;
  cart: CartObject | null;
  warnings: WarningObject[];
  trimAlternatives: TrimAlternativeObject[];
};

type CartChargeObject = JsonObject & {
  amount: MoneyObject;
};

type CartObject = JsonObject & {
  subtotal: MoneyObject;
  tax: MoneyObject;
  fee: MoneyObject;
  discount: MoneyObject;
  total: MoneyObject;
  categoryCharges: CartChargeObject[];
  accountCharges: CartChargeObject[];
};

type WarningObject = JsonObject & {
  thresholdId: string;
  threshold: MoneyObject;
  actual: MoneyObject;
  excess: MoneyObject;
  reason: string;
  alternatives: JsonObject[];
};

type TrimAlternativeObject = JsonObject & {
  removedItemIds: string[];
  retainedItemIds: string[];
  total: MoneyObject;
  outcome: string;
  categoryCharges: CartChargeObject[];
};

type RichCardObject = CardObject & {
  intentHash: string;
  cart: CartObject;
  warnings: WarningObject[];
  trimAlternatives: TrimAlternativeObject[];
};

type RequestObject = JsonObject & {
  financialSnapshot: SnapshotObject;
  context: ContextObject;
  items: ItemObject[];
  adjustments?: JsonObject[];
  warningThresholds?: JsonObject[];
  categoryPolicies: JsonObject[];
  validUntil: string;
  requestId: string;
  correlationId: string;
  decisionId: string;
};

const load = (relativePath: string): JsonObject =>
  JSON.parse(fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8')) as JsonObject;

const money = (minorUnits: string | number): MoneyObject => ({
  minorUnits: String(minorUnits),
  currency: 'USD',
});

const liquidityFixture = load(
  '../../protocol/fixtures/account-aware-liquidity.json',
) as LiquidityFixture;
const foundationFixture = load(
  '../../protocol/fixtures/financial-decision-foundation.json',
) as FoundationFixture;
const decisionCardSchema = load('../../protocol/json-schema/decision-card-v1.json') as AnySchemaObject;
const ajv = new Ajv({ allErrors: true, strict: false });
for (const name of [
  'protocol-v1',
  'financial-snapshot-v1',
  'prospective-decision-v1',
  'account-aware-liquidity-v1',
  'decision-card-v1',
]) {
  ajv.addSchema(load(`../../protocol/json-schema/${name}.json`));
}

function rootValidator(schema: AnySchemaObject): ValidateFunction {
  if (typeof schema.$id !== 'string') {
    throw new Error('Decision Card contract schema root must declare $id');
  }
  const validate = ajv.getSchema(schema.$id);
  if (!validate) {
    throw new Error(`AJV could not compile schema root ${schema.$id}`);
  }
  return validate;
}

const validateCard = rootValidator(decisionCardSchema);
const validateRequest = ajv.compile({
  $ref: `${decisionCardSchema.$id}#/$defs/DecisionCardRequest`,
});

function composeRequest(): RequestObject {
  const snapshot = structuredClone(foundationFixture.full);
  snapshot.snapshotId = liquidityFixture.snapshotId;
  snapshot.contentHash = liquidityFixture.contentHash;
  snapshot.capturedAt = liquidityFixture.evaluatedAt;
  snapshot.liquidity = structuredClone(liquidityFixture.facts);
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
      observedAt: liquidityFixture.evaluatedAt,
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

  const context = structuredClone(foundationFixture.claims.context);
  context.evaluatedAt = liquidityFixture.evaluatedAt;
  context.horizon = structuredClone(liquidityFixture.horizon);
  context.snapshotId = liquidityFixture.snapshotId;
  context.contentHash = liquidityFixture.contentHash;
  context.policyVersion = liquidityFixture.liquidityPolicy.version;
  context.policyHash = liquidityFixture.liquidityPolicy.policyHash;
  context.policy.maxBudgetSnapshotAgeMinutes = liquidityFixture.maxBudgetSnapshotAgeMinutes;
  context.policy.maxBankSyncAgeMinutes = null;

  const item = {
    ...structuredClone(liquidityFixture.scenario.items[0]),
    priority: 'planned',
  };
  return {
    financialSnapshot: snapshot,
    context,
    liquidityPolicy: structuredClone(liquidityFixture.liquidityPolicy),
    claimSet: structuredClone(liquidityFixture.claimSet),
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
    validUntil: liquidityFixture.validUntil,
    requestId: 'request-card-1',
    correlationId: 'correlation-card-1',
    decisionId: 'decision-card-1',
  };
}
function richRequest(): RequestObject {
  const request = composeRequest();
  const item = request.items[0];
  item.amount = money(800);
  item.quantity = 2;
  item.categoryAllocations = [
    { categoryId: 'food', amount: money(600) },
    { categoryId: 'household', amount: money(1000) },
  ];
  item.barcode = 'barcode-0001';
  item.priceProvenance = {
    kind: 'outside_price',
    source: 'retailer-feed',
    store: 'store-1',
    observedAt: '2026-09-06T09:30:00Z',
    estimate: true,
  };
  const facts = request.financialSnapshot.liquidity;
  if (!facts) {
    throw new Error('rich cart fixture requires liquidity facts');
  }
  facts.categories.push({
    ...facts.categories[0],
    categoryId: 'household',
    cashBucketId: 'household',
    availability: money(3000),
    periodKind: 'current',
    asOfMonth: '2026-09',
  });
  request.categoryPolicies.push({
    categoryId: 'household',
    kind: 'ordinary',
    donorEligible: false,
    minimumRetained: money(0),
    projectedRemainingNeed: money(0),
  });
  request.adjustments = [
    { kind: 'tax', categoryId: 'food', amount: money(300) },
    { kind: 'fee', categoryId: 'food', amount: money(200) },
    { kind: 'discount', categoryId: 'food', amount: money(100) },
  ];
  request.warningThresholds = [
    { id: 'cart-limit', basis: 'cart_total', maximum: money(1500) },
    {
      id: 'food-limit',
      basis: 'category_charge',
      categoryId: 'food',
      maximum: money(1200),
    },
  ];
  return request;
}

const evidence = {
  evidenceId: 'checking-freshness',
  kind: 'bank_sync',
  authorized: true,
  redaction: 'visible',
};

const backing = (): JsonObject => ({
  version: '1',
  snapshotId: 'snapshot-1',
  contentHash: 'composite-hash-1',
  policyVersion: 'policy-1',
  policyHash: 'policy-hash-1',
  claimSetRevision: 'claims-1',
  feasible: true,
  lines: [],
  reasons: [],
});

const categoryState = (availability: string): CategoryStateObject => ({
  categoryId: 'food',
  asOfMonth: '2026-09',
  availability: money(availability),
  commitments: money(0),
  reservations: money(0),
  uncommittedAvailability: money(availability),
  safeToRedirect: money(0),
  policyKind: 'ordinary',
});

const accountPrecondition = (accountId: string, recordedBalance: string): JsonObject => ({
  accountId,
  recordedBalance: money(recordedBalance),
  signedHeadroom: money(recordedBalance),
  backingCapacity: money(recordedBalance),
  baselineTransactionIds: [],
});

const state = (availability: string, runway: JsonObject): CardStateObject => ({
  categories: [categoryState(availability)],
  accounts: [],
  backing: backing(),
  goals: [
    {
      categoryId: 'food',
      asOfMonth: '2026-09',
      kind: 'goal',
      state: 'on_track',
      shortfall: money(0),
      minimumRetained: money(500),
      projectedRemainingNeed: money(500),
      requiredRetained: money(500),
      targetState: 'unknown',
      availability: money(2000),
      uncommittedAvailability: money(2000),
    },
  ],
  obligations: [
    {
      scheduleId: 'schedule-unknown',
      classification: 'commitment',
      accountId: 'checking',
      categoryId: null,
      dueAt: '2026-09-12T12:00:00Z',
      state: 'scheduled',
      recurring: true,
      amount: null,
      amountState: 'unknown',
    },
  ],
  runway,
});

const itemOutcome = (outcome: string, paymentLiquidityStatus = 'ready'): JsonObject => ({
  id: 'purchase-1',
  categoryId: 'food',
  amount: money(2000),
  priority: 'planned',
  outcome,
  budgetFundingStatus: 'funded',
  paymentLiquidityStatus,
  selectedAccountId: 'checking',
  selectionSource: 'explicit',
  reasons: [],
  before: null,
  after: null,
});

function baseCard(): CardObject {
  return {
    version: '1',
    decisionId: 'decision-card-1',
    requestId: 'request-card-1',
    correlationId: 'correlation-card-1',
    snapshotId: 'snapshot-1',
    contentHash: 'composite-hash-1',
    policyVersion: 'policy-1',
    policyHash: 'policy-hash-1',
    claimSetRevision: 'claims-1',
    planHash: 'a'.repeat(64),
    outcome: 'funded_now',
    budgetFundingStatus: 'funded',
    paymentLiquidityStatus: 'ready',
    selectedAccountId: 'checking',
    selectionSource: 'explicit',
    before: state('2000', {
      state: 'known',
      accountId: 'checking',
      remainingSafeCash: money(9000),
      basis: 'selected_account_safe_spending_capacity',
    }),
    after: state('0', {
      state: 'known',
      accountId: 'checking',
      remainingSafeCash: money(7000),
      basis: 'selected_account_safe_spending_capacity',
    }),
    fundingPaths: [],
    opportunityCosts: [],
    conflicts: [],
    authorizationRequirements: [],
    evidence: [evidence],
    blockers: [],
    reasons: ['category_funded'],
    assumptions: [],
    earliestExpiry: '2026-09-06T18:00:00Z',
    expiresAt: '2026-09-06T18:00:00Z',
    readiness: {
      outcome: 'funded_now',
      status: 'evaluated',
      blockers: [],
      budgetFundingStatus: 'funded',
      paymentLiquidityStatus: 'ready',
    },
    items: [itemOutcome('funded_now')],
    intentHash: 'd'.repeat(64),
    cart: {
      subtotal: money(2000),
      tax: money(0),
      fee: money(0),
      discount: money(0),
      total: money(2000),
      categoryCharges: [{ categoryId: 'food', amount: money(2000) }],
      accountCharges: [{ accountId: 'checking', amount: money(2000) }],
    },
    warnings: [],
    trimAlternatives: [],
  };
}
function richCard(): RichCardObject {
  const card = baseCard() as RichCardObject;
  card.before.categories = [
    { ...categoryState('4000'), categoryId: 'food' },
    { ...categoryState('3000'), categoryId: 'household' },
  ];
  card.after!.categories = [
    { ...categoryState('3400'), categoryId: 'food' },
    { ...categoryState('2000'), categoryId: 'household' },
  ];
  card.items[0].amount = money(1600);
  card.cart = {
    subtotal: money(1600),
    tax: money(0),
    fee: money(0),
    discount: money(0),
    total: money(1600),
    categoryCharges: [
      { categoryId: 'food', amount: money(600) },
      { categoryId: 'household', amount: money(1000) },
    ],
    accountCharges: [{ accountId: 'checking', amount: money(1600) }],
  };
  card.warnings = [
    {
      thresholdId: 'cart-limit',
      threshold: money(1500),
      actual: money(1600),
      excess: money(100),
      reason: 'threshold_exceeded',
      alternatives: [],
    },
    {
      thresholdId: 'food-limit',
      threshold: money(1200),
      actual: money(1600),
      excess: money(400),
      reason: 'threshold_exceeded',
      alternatives: [],
    },
  ];
  card.trimAlternatives = [
    {
      removedItemIds: ['optional-item'],
      retainedItemIds: ['required-item', 'planned-item'],
      total: money(2150),
      outcome: 'funded_now',
      categoryCharges: [{ categoryId: 'food', amount: money(2150) }],
    },
    {
      removedItemIds: ['optional-item', 'planned-item'],
      retainedItemIds: ['required-item'],
      total: money(1150),
      outcome: 'funded_now',
      categoryCharges: [{ categoryId: 'food', amount: money(1150) }],
    },
  ];
  return card;
}

const transferPath = (): TransferPathObject => ({
  kind: 'account_transfer',
  itemId: 'purchase-1',
  itemIds: ['purchase-1'],
  version: '1',
  snapshotId: 'snapshot-1',
  contentHash: 'composite-hash-1',
  policyVersion: 'policy-1',
  policyHash: 'policy-hash-1',
  claimSetRevision: 'claims-1',
  evaluatedAt: '2026-09-06T10:00:00Z',
  expiresAt: '2026-09-06T18:00:00Z',
  minimumAmount: money(2000),
  legs: [
    {
      id: 'savings-checking-1',
      sourceAccountId: 'savings',
      destinationAccountId: 'checking',
      amount: money(2000),
      requiredBy: '2026-09-06T12:00:00Z',
      estimatedArrival: '2026-09-06T11:00:00Z',
      timingRouteId: 'savings-checking',
      sourceBefore: accountPrecondition('savings', '20000'),
      destinationBefore: accountPrecondition('checking', '9000'),
      sourceAfter: money('18000'),
      destinationAfter: money('11000'),
    },
  ],
  reservations: [],
  backingAfter: backing(),
  scenario: {
    kind: 'purchases',
    items: [
      {
        id: 'purchase-1',
        categoryId: 'food',
        amount: money(2000),
        purchaseAt: '2026-09-06T12:00:00Z',
        requiredBy: '2026-09-06T12:00:00Z',
        routeSelection: {
          explicitAccountId: 'checking',
          sessionAccountId: null,
          approvedPreference: null,
          historicalRoute: null,
        },
      },
    ],
  },
  preconditionsHash: 'b'.repeat(64),
  payloadHash: 'c'.repeat(64),
});

function safeAfterCard(): CardObject {
  const card = baseCard();
  card.outcome = 'safe_after_date';
  card.paymentLiquidityStatus = 'transfer_required';
  card.fundingPaths = [transferPath()];
  card.authorizationRequirements = ['account_transfer_approval'];
  card.readiness = {
    outcome: 'safe_after_date',
    status: 'evaluated',
    blockers: [],
    budgetFundingStatus: 'funded',
    paymentLiquidityStatus: 'transfer_required',
  };
  card.items = [itemOutcome('safe_after_date', 'transfer_required')];
  return card;
}

function insufficientCard(): CardObject {
  const card = baseCard();
  card.outcome = 'insufficient_data';
  card.budgetFundingStatus = 'insufficient_data';
  card.paymentLiquidityStatus = 'insufficient_data';
  card.before.runway = {
    state: 'unknown',
    accountId: 'checking',
    remainingSafeCash: null,
  };
  card.after = null;
  card.cart = null;
  card.fundingPaths = [];
  card.items = [];
  card.blockers = ['account_freshness'];
  card.reasons = ['account_freshness'];
  card.readiness = {
    outcome: 'insufficient_data',
    status: 'blocked',
    blockers: ['account_freshness'],
  };
  return card;
}

describe('independent Decision Card JSON Schema roots', () => {
  it('accepts the canonical composed request and representative funded/safe-after cards', () => {
    const request = composeRequest();
    expect(validateRequest(request), JSON.stringify(validateRequest.errors)).toBe(true);

    const funded = baseCard();
    expect(validateCard(funded), JSON.stringify(validateCard.errors)).toBe(true);
    const safeAfter = safeAfterCard();
    expect(validateCard(safeAfter), JSON.stringify(validateCard.errors)).toBe(true);
    expect(safeAfter.fundingPaths[0].legs[0].estimatedArrival).toBe(
      '2026-09-06T11:00:00Z',
    );
    expect(funded.before.categories[0].asOfMonth).toBe('2026-09');
    expect(funded.before.categories[0].availability).toEqual(money(2000));
    expect(funded.after!.categories[0].availability).toEqual(money(0));
  });
  it('accepts the full Phase 8.6 cart request wire at the independent boundary', () => {
    const request = richRequest();
    expect(validateRequest(request), JSON.stringify(validateRequest.errors)).toBe(true);
    expect(request.items[0].quantity).toBe(2);
    expect(request.items[0].categoryAllocations).toHaveLength(2);
    expect(request.items[0].priceProvenance).toMatchObject({
      kind: 'outside_price',
      source: 'retailer-feed',
    });
    expect(request.adjustments).toHaveLength(3);
    expect(request.warningThresholds).toHaveLength(2);
    expect(request.financialSnapshot.liquidity?.categories).toEqual(
      expect.arrayContaining([expect.objectContaining({ asOfMonth: '2026-09', categoryId: 'household' })]),
    );
  });
  it('accepts an outside price without a known store and preserves the omitted store', () => {
    const request = richRequest();
    delete request.items[0]!.priceProvenance!.store;
    expect(validateRequest(request), JSON.stringify(validateRequest.errors)).toBe(true);
  });

  it.each([
    [
      'zero category allocation',
      (request: RequestObject) => (request.items[0].categoryAllocations![0]!.amount = money(0)),
    ],
    [
      'invalid price provenance kind',
      (request: RequestObject) =>
        (request.items[0].priceProvenance!.kind = 'vendor_price'),
    ],
    [
      'outside provenance without source',
      (request: RequestObject) =>
        (request.items[0].priceProvenance = {
          kind: 'outside_price',
          store: 'store-1',
          observedAt: '2026-09-06T09:30:00Z',
          estimate: true,
        }),
    ],
    [
      'outside provenance with blank store',
      (request: RequestObject) =>
        (request.items[0]!.priceProvenance = {
          kind: 'outside_price',
          source: 'retailer-feed',
          store: ' ',
          observedAt: '2026-09-06T09:30:00Z',
          estimate: true,
        }),
    ],
    [
      'non-canonical provenance timestamp',
      (request: RequestObject) =>
        (request.items[0].priceProvenance!.observedAt = '2026-09-06T09:30:00+00:00'),
    ],
    [
      'invalid adjustment kind',
      (request: RequestObject) => (request.adjustments![0]!.kind = 'surcharge'),
    ],
    [
      'zero adjustment amount',
      (request: RequestObject) => (request.adjustments![0]!.amount = money(0)),
    ],
    [
      'invalid threshold basis',
      (request: RequestObject) => (request.warningThresholds![0]!.basis = 'line_total'),
    ],
    [
      'category threshold without category identity',
      (request: RequestObject) =>
        (request.warningThresholds![1] = {
          id: 'food-limit',
          basis: 'category_charge',
          maximum: money(1200),
        }),
    ],
    [
      'unknown allocation field',
      (request: RequestObject) => (request.items[0].categoryAllocations![0]!.untrusted = true),
    ],
    [
      'unknown provenance field',
      (request: RequestObject) => (request.items[0].priceProvenance!.untrusted = true),
    ],
    [
      'unknown adjustment field',
      (request: RequestObject) => (request.adjustments![0]!.untrusted = true),
    ],
    [
      'unknown threshold field',
      (request: RequestObject) => (request.warningThresholds![0]!.untrusted = true),
    ],
  ])('rejects rich request %s independently', (_name, mutate) => {
    const request = richRequest();
    mutate(request);
    expect(validateRequest(request)).toBe(false);
  });

  it('documents the JSON Schema arithmetic boundary for cart identity and line totals', () => {
    const mismatched = richRequest();
    mismatched.items[0].categoryAllocations = [
      { categoryId: 'food', amount: money(600) },
      { categoryId: 'household', amount: money(999) },
    ];
    expect(validateRequest(mismatched)).toBe(true);

    const duplicate = richRequest();
    duplicate.items.push({ ...structuredClone(duplicate.items[0]), amount: money(900) });
    expect(validateRequest(duplicate)).toBe(true);
    const duplicateAllocation = richRequest();
    duplicateAllocation.items[0].categoryAllocations = [
      { categoryId: 'food', amount: money(600) },
      { categoryId: 'food', amount: money(1000) },
    ];
    expect(validateRequest(duplicateAllocation)).toBe(true);
    // uniqueItems rejects whole-object duplicates; Rust owns duplicate item
    // and allocation identities across different payloads plus checked
    // line-total arithmetic (draft-07 cannot express these invariants).
  });

  it('accepts unknown runway evidence and requires insufficient-data after to be null', () => {
    const card = insufficientCard();
    expect(validateCard(card), JSON.stringify(validateCard.errors)).toBe(true);
    expect(card.before.runway).toEqual({
      state: 'unknown',
      accountId: 'checking',
      remainingSafeCash: null,
    });
    expect(card.after).toBeNull();
    expect(card.cart).toBeNull();
    const unsafeProjection = structuredClone(card);
    unsafeProjection.after = baseCard().after;
    expect(validateCard(unsafeProjection)).toBe(false);
  });

  it('permits a known cart total with a blocked financial conclusion and null after state', () => {
    const blocked = insufficientCard();
    blocked.cart = baseCard().cart;
    expect(validateCard(blocked), JSON.stringify(validateCard.errors)).toBe(true);
    expect(blocked.after).toBeNull();
  });

  it.each([
    ['zero amount', (request: RequestObject) => (request.items[0].amount.minorUnits = '0')],
    ['negative amount', (request: RequestObject) => (request.items[0].amount.minorUnits = '-1')],
    [
      'signed i64 overflow',
      (request: RequestObject) => (request.items[0].amount.minorUnits = '9223372036854775808'),
    ],
    ['non-canonical amount', (request: RequestObject) => (request.items[0].amount.minorUnits = '01')],
    ['zero quantity', (request: RequestObject) => (request.items[0].quantity = 0)],
    ['negative quantity', (request: RequestObject) => (request.items[0].quantity = -1)],
    ['fractional quantity', (request: RequestObject) => (request.items[0].quantity = 1.5)],
    ['quantity overflow', (request: RequestObject) => (request.items[0].quantity = 4_294_967_296)],
    ['quantity encoded as text', (request: RequestObject) => (request.items[0].quantity = '2')],
    ['unsupported priority', (request: RequestObject) => (request.items[0].priority = 'later')],
    ['malformed timestamp', (request: RequestObject) => (request.validUntil = 'not-a-time')],
  ])('rejects %s at the independent boundary', (_name, mutate) => {
    const request = composeRequest();
    mutate(request);
    expect(validateRequest(request)).toBe(false);
  });

  it('rejects unknown request and response fields without stripping them', () => {
    const request = composeRequest();
    request.untrusted = true;
    expect(validateRequest(request)).toBe(false);

    const nestedRequest = composeRequest();
    nestedRequest.items[0].displayName = 'not protocol data';
    expect(validateRequest(nestedRequest)).toBe(false);

    const response = baseCard();
    response.untrusted = true;
    expect(validateCard(response)).toBe(false);

    const nestedResponse = baseCard();
    nestedResponse.before.categories[0].untrusted = true;
    expect(validateCard(nestedResponse)).toBe(false);
  });

  it.each([
    ['fabricated money', (card: CardObject) => (card.before.categories[0].availability.minorUnits = '01')],
    ['malformed expiry', (card: CardObject) => (card.expiresAt = '2026-09-06T18:00:00+00:00')],
    ['unsupported outcome', (card: CardObject) => (card.outcome = 'maybe')],
  ])('rejects %s in the independent card schema', (_name, mutate) => {
    const card = baseCard();
    mutate(card);
    expect(validateCard(card)).toBe(false);
  });
  it('accepts the Phase 8.6 response cart, intent hash, threshold warnings, and trim alternatives', () => {
    const card = richCard();
    expect(validateCard(card), JSON.stringify(validateCard.errors)).toBe(true);
    expect(card.intentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(card.cart.subtotal).toEqual(money(1600));
    expect(card.before.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          categoryId: 'food',
          asOfMonth: '2026-09',
          availability: money(4000),
        }),
        expect.objectContaining({
          categoryId: 'household',
          asOfMonth: '2026-09',
          availability: money(3000),
        }),
      ]),
    );
    expect(card.after!.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          categoryId: 'food',
          asOfMonth: '2026-09',
          availability: money(3400),
        }),
        expect.objectContaining({
          categoryId: 'household',
          asOfMonth: '2026-09',
          availability: money(2000),
        }),
      ]),
    );
    expect(card.cart.categoryCharges).toEqual([
      { categoryId: 'food', amount: money(600) },
      { categoryId: 'household', amount: money(1000) },
    ]);
    expect(card.cart.accountCharges).toEqual([{ accountId: 'checking', amount: money(1600) }]);
    expect(card.warnings[0]).toMatchObject({
      thresholdId: 'cart-limit',
      threshold: money(1500),
      actual: money(1600),
      excess: money(100),
    });
    expect(card.warnings[1].alternatives).toEqual([]);
    expect(card.trimAlternatives[0]).toMatchObject({
      removedItemIds: ['optional-item'],
      retainedItemIds: ['required-item', 'planned-item'],
      total: money(2150),
      outcome: 'funded_now',
    });
    expect(card.trimAlternatives[1].categoryCharges[0].amount).toEqual(money(1150));

    const adjusted = richCard();
    adjusted.cart.tax = money(300);
    adjusted.cart.fee = money(200);
    adjusted.cart.discount = money(100);
    adjusted.cart.total = money(2000);
    adjusted.cart.categoryCharges = [{ categoryId: 'food', amount: money(2000) }];
    adjusted.cart.accountCharges = [{ accountId: 'checking', amount: money(2000) }];
    expect(validateCard(adjusted), JSON.stringify(validateCard.errors)).toBe(true);
    expect(adjusted.cart).toMatchObject({
      subtotal: money(1600),
      tax: money(300),
      fee: money(200),
      discount: money(100),
      total: money(2000),
    });
    expect(adjusted.cart.categoryCharges).toEqual([
      { categoryId: 'food', amount: money(2000) },
    ]);
  });

  it.each([
    ['invalid intent hash', (card: RichCardObject) => (card.intentHash = 'not-a-sha256')],
    [
      'zero category child charge',
      (card: RichCardObject) => (card.cart.categoryCharges[0]!.amount = money(0)),
    ],
    [
      'non-canonical warning amount',
      (card: RichCardObject) => (card.warnings[0]!.actual.minorUnits = '01'),
    ],
    ['unknown cart field', (card: RichCardObject) => (card.cart.untrusted = true)],
    ['unknown warning field', (card: RichCardObject) => (card.warnings[0]!.untrusted = true)],
    [
      'unknown trim-alternative field',
      (card: RichCardObject) => (card.trimAlternatives[0]!.untrusted = true),
    ],
  ])('rejects rich response %s in the independent schema', (_name, mutate) => {
    const card = richCard();
    mutate(card);
    expect(validateCard(card)).toBe(false);
  });
});

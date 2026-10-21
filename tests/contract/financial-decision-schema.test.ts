import { registerProtocolSchemas } from './src/schema-registry.js';
import Ajv, { type AnySchemaObject, type ValidateFunction } from 'ajv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  financialSnapshotSchema as zodFinancialSnapshotSchema,
  moneySchema,
  sourceObservationSchema,
} from '@balanceframe/protocol-generated/validators';

type JsonObject = Record<string, unknown>;

type FinancialDecisionFixture = {
  full: JsonObject & {
    legacySnapshot: unknown;
    coverage: JsonObject;
    observations: JsonObject[];
  };
  unknownVsEmpty: {
    unknownCoverage: JsonObject;
    explicitEmptyCoverage: JsonObject;
  };
  claims: { items: JsonObject[] };
  decisions: {
    ready: JsonObject;
    qualified: JsonObject;
    blocked: JsonObject;
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = (name: string) => path.resolve(__dirname, '../../protocol/json-schema', name);

function loadJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
}

function loadSchema(name: string): AnySchemaObject {
  return loadJson(schemaPath(name)) as AnySchemaObject;
}

const legacyProtocolSchema = loadSchema('protocol-v1.json');
const financialSnapshotSchema = loadSchema('financial-snapshot-v1.json');
const prospectiveClaimSchema = loadSchema('prospective-claim-v1.json');
const prospectiveDecisionSchema = loadSchema('prospective-decision-v1.json');
const foundationFixture = loadJson(
  path.resolve(__dirname, '../../protocol/fixtures/financial-decision-foundation.json'),
) as FinancialDecisionFixture;
const actionFixture = loadJson(
  path.resolve(__dirname, '../../protocol/fixtures/consequential-action.json'),
) as {
  evidenceProjectionIntent: { transaction: JsonObject };
  sourceObservation: JsonObject;
};
const ajv = new Ajv({ allErrors: true, strict: false });
registerProtocolSchemas(ajv);

function rootValidator(schema: AnySchemaObject): ValidateFunction {
  if (typeof schema.$id !== 'string') {
    throw new Error('Independent contract schema root must declare $id');
  }
  const validate = ajv.getSchema(schema.$id);
  if (!validate) {
    throw new Error(`AJV could not compile schema root ${schema.$id}`);
  }
  return validate;
}

const validateFinancialSnapshot = rootValidator(financialSnapshotSchema);
const validateProspectiveClaim = rootValidator(prospectiveClaimSchema);
const validateProspectiveDecision = rootValidator(prospectiveDecisionSchema);

if (typeof legacyProtocolSchema.$id !== 'string') {
  throw new Error('protocol-v1 schema must declare $id');
}
const validatePurchaseEvaluation = ajv.compile({
  $ref: `${legacyProtocolSchema.$id}#/$defs/PurchaseEvaluation`,
});

function expectValid(validate: ValidateFunction, value: unknown): void {
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

function financialSnapshot(): JsonObject {
  return structuredClone(foundationFixture.full);
}

function prospectiveClaim(minorUnits?: string): JsonObject {
  const fixtureClaim = foundationFixture.claims.items[0];
  if (!fixtureClaim) {
    throw new Error('Foundation fixture must contain a prospective claim');
  }
  const claim = structuredClone(fixtureClaim);
  if (minorUnits !== undefined) {
    (claim.amount as JsonObject).minorUnits = minorUnits;
  }
  return claim;
}

function prospectivePurchaseDecision(): JsonObject {
  return structuredClone(foundationFixture.decisions.blocked);
}

describe('independent financial decision JSON Schema roots', () => {
  it('validates a focused financial snapshot', () => {
    expectValid(validateFinancialSnapshot, financialSnapshot());
  });

  it('validates a focused prospective claim', () => {
    expectValid(validateProspectiveClaim, prospectiveClaim());
  });

  it('validates a focused prospective purchase decision', () => {
    expectValid(validateProspectiveDecision, prospectivePurchaseDecision());
  });
});

describe('forward-compatible issue and coverage vocabulary', () => {
  it('accepts unknown issue codes while the fixture fails closed', () => {
    const decision = prospectivePurchaseDecision();
    const unknownIssue = (decision.issues as JsonObject[]).find(
      ({ code }) => code === 'fd_future_safety_code',
    );

    expect(unknownIssue).toMatchObject({
      severity: 'critical',
      effect: 'qualifies',
    });
    expect(decision.readiness).toBe('blocked');
    expectValid(validateProspectiveDecision, decision);
    expect(unknownIssue?.code).toBe('fd_future_safety_code');
  });

  it('keeps omitted unknown coverage distinct from explicitly empty coverage', () => {
    const unknownCoverage = financialSnapshot();
    unknownCoverage.coverage = structuredClone(foundationFixture.unknownVsEmpty.unknownCoverage);
    const explicitEmptyCoverage = financialSnapshot();
    explicitEmptyCoverage.coverage = structuredClone(
      foundationFixture.unknownVsEmpty.explicitEmptyCoverage,
    );

    expectValid(validateFinancialSnapshot, unknownCoverage);
    expectValid(validateFinancialSnapshot, explicitEmptyCoverage);
    expect('transactions' in (unknownCoverage.coverage as JsonObject)).toBe(false);
    expect((explicitEmptyCoverage.coverage as JsonObject).transactions).toBe('empty');
  });

  it('accepts explicit unavailable coverage from the Rust snapshot contract', () => {
    const snapshot = financialSnapshot();
    const unavailableCoverage = {
      accounts: 'unavailable',
      transactions: 'unavailable',
      categories: 'unavailable',
      payees: 'unavailable',
      rules: 'unavailable',
      schedules: 'unavailable',
      budgets: 'unavailable',
      tags: 'unavailable',
    };
    snapshot.coverage = unavailableCoverage;

    expectValid(validateFinancialSnapshot, snapshot);
    expect(snapshot.coverage).toEqual(unavailableCoverage);
  });

  it('accepts unknown as the exact shared observation-state wire value', () => {
    const snapshot = financialSnapshot();
    const observation = (snapshot.observations as JsonObject[])[0];
    if (!observation) {
      throw new Error('Foundation fixture must contain a source observation');
    }
    observation.state = 'unknown';

    expectValid(validateFinancialSnapshot, snapshot);
    expect(observation.state).toBe('unknown');
  });
});

describe('money, time, redaction, and evidence boundaries', () => {
  it('accepts signed zero and i64 bounds and rejects malformed Money without throwing', () => {
    for (const minorUnits of ['0', '-1', '9223372036854775807', '-9223372036854775808']) {
      const claim = prospectiveClaim(minorUnits);
      expectValid(validateProspectiveClaim, claim);
      expect(moneySchema.safeParse(claim.amount).success).toBe(true);
    }

    for (const minorUnits of [
      '9223372036854775808',
      '-9223372036854775809',
      'not-money',
      '-0',
      '+1',
      '01',
      '-01',
    ]) {
      const claim = prospectiveClaim(minorUnits);
      expect(validateProspectiveClaim(claim)).toBe(false);
      expect(() => moneySchema.safeParse(claim.amount)).not.toThrow();
      expect(moneySchema.safeParse(claim.amount).success).toBe(false);
    }

    const malformedCurrency = prospectiveClaim();
    (malformedCurrency.amount as JsonObject).currency = 'usd';
    expect(validateProspectiveClaim(malformedCurrency)).toBe(false);
    expect(moneySchema.safeParse(malformedCurrency.amount).success).toBe(false);
  });

  it('accepts canonical three-digit fractional UTC timestamps at every root', () => {
    const snapshot = financialSnapshot();
    snapshot.capturedAt = '2026-08-23T12:00:00.412Z';
    expectValid(validateFinancialSnapshot, snapshot);

    const claim = prospectiveClaim();
    claim.effectiveFrom = '2026-08-23T12:00:00.412Z';
    claim.expiresAt = '2026-09-01T00:00:00.412Z';
    expectValid(validateProspectiveClaim, claim);

    const decision = prospectivePurchaseDecision();
    const metadata = decision.metadata as JsonObject;
    const context = metadata.context as JsonObject;
    context.evaluatedAt = '2026-08-23T12:00:00.412Z';
    decision.expiresAt = '2026-08-23T12:05:00.412Z';
    expectValid(validateProspectiveDecision, decision);
  });

  it('rejects malformed or non-canonical fixed-UTC timestamps at every root', () => {
    const snapshot = financialSnapshot();
    snapshot.capturedAt = '2026-08-23 12:34:56Z';
    expect(validateFinancialSnapshot(snapshot)).toBe(false);

    const claim = prospectiveClaim();
    claim.effectiveFrom = '2026-08-23T12:00:00+01:00';
    expect(validateProspectiveClaim(claim)).toBe(false);

    const decision = prospectivePurchaseDecision();
    decision.expiresAt = '2026-13-40T25:61:61Z';
    expect(validateProspectiveDecision(decision)).toBe(false);
  });

  it('allows typed evidence references but rejects raw evidence content', () => {
    const snapshot = financialSnapshot();
    expectValid(validateFinancialSnapshot, snapshot);

    const rawSnapshot = structuredClone(snapshot);
    const rawObservation = (rawSnapshot.observations as Array<Record<string, unknown>>)[0];
    const rawEvidence = (rawObservation.evidence as Array<Record<string, unknown>>)[0];
    rawEvidence.content = { balance: 'private ledger content' };
    expect(validateFinancialSnapshot(rawSnapshot)).toBe(false);

    const rawDecision = prospectivePurchaseDecision();
    (rawDecision.evidence as Array<Record<string, unknown>>)[0].rawContent =
      'private budget content';
    expect(validateProspectiveDecision(rawDecision)).toBe(false);
  });

  it('restricts redaction fields to the shared visible/redacted states', () => {
    const fixtureClaim = foundationFixture.claims.items.find(
      ({ visibility }) => visibility === 'redacted',
    );
    expect(fixtureClaim).toBeDefined();
    expectValid(validateProspectiveClaim, fixtureClaim);

    const invalidClaim = prospectiveClaim();
    invalidClaim.visibility = 'masked';
    expect(validateProspectiveClaim(invalidClaim)).toBe(false);

    const invalidDecision = prospectivePurchaseDecision();
    invalidDecision.redaction = 'masked';
    expect(validateProspectiveDecision(invalidDecision)).toBe(false);
  });
});

describe('economic event resolution source metadata', () => {
  const sourceObservation = actionFixture.sourceObservation;

  it('requires strict, current event-resolution provenance while preserving old snapshots', () => {
    const oldSnapshot = financialSnapshot();
    expectValid(validateFinancialSnapshot, oldSnapshot);
    expect(zodFinancialSnapshotSchema.safeParse(oldSnapshot).success).toBe(true);

    const currentSnapshot = financialSnapshot();
    currentSnapshot.observations.push(structuredClone(sourceObservation));
    expectValid(validateFinancialSnapshot, currentSnapshot);
    expect(zodFinancialSnapshotSchema.safeParse(currentSnapshot).success).toBe(true);
    expect(sourceObservationSchema.safeParse(sourceObservation).success).toBe(true);
    const transaction = actionFixture.evidenceProjectionIntent.transaction;
    expect(sourceObservation.ledgerEffect).toEqual({
      accountId: transaction.accountId,
      amount: transaction.amount,
      date: transaction.date,
      categoryId: transaction.categoryId,
      payeeName: transaction.payeeName,
      notes: transaction.notes,
      splits: transaction.splits,
    });
  });

  it('rejects missing, stale, mismatched, or non-visible event provenance in both contracts', () => {
    const invalidObservations: JsonObject[] = [];
    const missingHash = structuredClone(sourceObservation);
    delete missingHash.contentHash;
    invalidObservations.push(missingHash);
    const emptyHash = structuredClone(sourceObservation);
    emptyHash.contentHash = '';
    invalidObservations.push(emptyHash);
    const missingVersion = structuredClone(sourceObservation);
    const missingLedgerEffect = structuredClone(sourceObservation);
    delete missingLedgerEffect.ledgerEffect;
    invalidObservations.push(missingLedgerEffect);
    const missingEffectAmount = structuredClone(sourceObservation);
    delete (missingEffectAmount.ledgerEffect as JsonObject).amount;
    invalidObservations.push(missingEffectAmount);
    const invalidEffectDate = structuredClone(sourceObservation);
    (invalidEffectDate.ledgerEffect as JsonObject).date = '2026-09-06T00:00:00Z';
    invalidObservations.push(invalidEffectDate);
    const unknownEffectField = structuredClone(sourceObservation);
    (unknownEffectField.ledgerEffect as JsonObject).unexpected = true;
    invalidObservations.push(unknownEffectField);
    delete missingVersion.version;
    invalidObservations.push(missingVersion);
    const emptyVersion = structuredClone(sourceObservation);
    emptyVersion.version = '';
    const missingObservationTime = structuredClone(sourceObservation);
    delete missingObservationTime.observedAt;
    invalidObservations.push(missingObservationTime);
    const invalidObservationTime = structuredClone(sourceObservation);
    invalidObservationTime.observedAt = '2026-09-06 09:30:00Z';
    invalidObservations.push(invalidObservationTime);
    const emptySubject = structuredClone(sourceObservation);
    emptySubject.scope = { kind: 'transaction', id: '' };
    invalidObservations.push(emptySubject);
    const missingSubject = structuredClone(sourceObservation);
    missingSubject.scope = { kind: 'transaction' };
    invalidObservations.push(missingSubject);
    const wrongSubject = structuredClone(sourceObservation);
    wrongSubject.scope = { kind: 'category', id: 'manual-parent-evidence-1' };
    invalidObservations.push(wrongSubject);
    const stale = structuredClone(sourceObservation);
    stale.state = 'stale';
    invalidObservations.push(stale);
    const emptyEvidence = structuredClone(sourceObservation);
    emptyEvidence.evidence = [];
    invalidObservations.push(emptyEvidence);
    const unauthorized = structuredClone(sourceObservation);
    (unauthorized.evidence as JsonObject[])[0]!.authorized = false;
    invalidObservations.push(unauthorized);
    const wrongEvidenceKind = structuredClone(sourceObservation);
    (wrongEvidenceKind.evidence as JsonObject[])[0]!.kind = 'transaction_resolution';
    invalidObservations.push(wrongEvidenceKind);
    const redacted = structuredClone(sourceObservation);
    (redacted.evidence as JsonObject[])[0]!.redaction = 'redacted';
    invalidObservations.push(redacted);
    const unknownNestedField = structuredClone(sourceObservation);
    (unknownNestedField.evidence as JsonObject[])[0]!.extra = true;
    invalidObservations.push(unknownNestedField);
    const unknownField = structuredClone(sourceObservation);
    unknownField.extra = true;
    invalidObservations.push(unknownField);
    const ordinarySnapshot = financialSnapshot();
    const ordinaryObservation = ordinarySnapshot.observations.find(
      ({ kind }) => kind !== 'economic_event_resolution',
    );
    if (!ordinaryObservation) throw new Error('canonical non-event source observation is required');
    ordinaryObservation.ledgerEffect = structuredClone(sourceObservation.ledgerEffect);
    expect(validateFinancialSnapshot(ordinarySnapshot)).toBe(false);
    expect(zodFinancialSnapshotSchema.safeParse(ordinarySnapshot).success).toBe(false);

    for (const observation of invalidObservations) {
      const snapshot = financialSnapshot();
      snapshot.observations.push(observation);
      expect(validateFinancialSnapshot(snapshot)).toBe(false);
      expect(zodFinancialSnapshotSchema.safeParse(snapshot).success).toBe(false);
      expect(sourceObservationSchema.safeParse(observation).success).toBe(false);
    }
  });
});

describe('legacy protocol compatibility', () => {
  it('keeps protocol-v1 fixtures unchanged and valid', () => {
    const representative = loadJson(
      path.resolve(__dirname, '../../protocol/fixtures/representative.json'),
    );
    const originalRepresentative = structuredClone(representative);
    const legacySnapshot = structuredClone(foundationFixture.full.legacySnapshot);
    const originalLegacySnapshot = structuredClone(legacySnapshot);
    const validateLegacyProtocol = rootValidator(legacyProtocolSchema);

    expectValid(validateLegacyProtocol, representative);
    expectValid(validateLegacyProtocol, legacySnapshot);
    expect(representative).toEqual(originalRepresentative);
    expect(legacySnapshot).toEqual(originalLegacySnapshot);
  });

  it('keeps legacy PurchaseEvaluation fixtures unchanged and valid', () => {
    for (const decisionFixture of Object.values(foundationFixture.decisions)) {
      const decision = structuredClone(decisionFixture);
      const original = structuredClone(decision);
      const payload = decision.payload;

      expectValid(validatePurchaseEvaluation, payload);
      expectValid(validateProspectiveDecision, decision);
      expect(decision).toEqual(original);
    }
  });
});

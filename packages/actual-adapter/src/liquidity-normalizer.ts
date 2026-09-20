import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  APIAccountEntity,
  APICategoryEntity,
  APIScheduleEntity,
} from '@actual-app/api/models';
import type { TransactionEntity } from '@actual-app/core/types/models';
import type {
  AccountLiquidityFact,
  CashObligation,
  CategoryLiquidityFact,
  FactEvidence,
  FinancialSnapshot,
  LiquidityFacts,
  Money,
  ScheduleLiquidityFact,
  TransferSettlementRecord,
  UnsettledFlow,
} from '@balanceframe/protocol-generated';
import {
  cashObligationSchema,
  creditLiquidityFactSchema,
  factEvidenceSchema,
  liquidityAccountKindSchema,
  liquidityFactsSchema,
  moneySchema,
  unsettledFlowSchema,
  scheduleRecurrenceSchema,
} from '@balanceframe/protocol-generated/validators';

/** A successful empty source collection differs from an unreadable collection. */
export type ActualLiquidityCollection<T> =
  { available: true; items: T[] } | { available: false; items: [] };

/** Actual getBudgetMonth source representation; balance is authoritative, not budgeted minus spent. */
export interface ActualLiquidityBudgetMonth {
  month: string;
  categoryGroups: Array<{ categories?: Array<Record<string, unknown>> }>;
}

/** Provider data is normalized here and never passed across the native boundary. */
export interface ActualLiquidityNormalizationInput {
  capturedAt: string;
  ledgerContentHash: string;
  currency: string;
  accounts: ActualLiquidityCollection<APIAccountEntity>;
  categories: ActualLiquidityCollection<APICategoryEntity>;
  budgetMonths: ActualLiquidityBudgetMonth[];
  transactions: Array<{ accountId: string; read: ActualLiquidityCollection<TransactionEntity> }>;
  schedules: ActualLiquidityCollection<APIScheduleEntity>;
}

function evidence(
  state: FactEvidence['state'],
  capturedAt: string,
  reasons: string[] = [],
): FactEvidence {
  return {
    state,
    source: 'actual_ledger',
    observedAt: state === 'known' ? capturedAt : null,
    expiresAt: null,
    reasons,
  };
}

function sourceInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function sourceMoney(value: number, currency: string): Money {
  if (!sourceInteger(value)) throw new Error('Actual amount is not an exact safe integer');
  return moneySchema.strict().parse({ minorUnits: String(value), currency });
}

function sourceId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function liveTransactions(transactions: TransactionEntity[]): TransactionEntity[] {
  // Split parent totals are already included in account balances. Never double count children.
  return transactions.filter((transaction) => !transaction.tombstone && !transaction.is_child);
}

/** Preserve independent schedule IDs and signed ranges, without turning an estimate into an exact obligation. */
export function normalizeActualScheduleLiquiditySource(
  schedule: APIScheduleEntity,
  currency: string,
): ScheduleLiquidityFact {
  const range = schedule.amount;
  const bounded =
    typeof range === 'object' &&
    range !== null &&
    'num1' in range &&
    'num2' in range &&
    sourceInteger(range.num1) &&
    sourceInteger(range.num2);
  return {
    id: schedule.id,
    accountId: sourceId(schedule.account),
    categoryId: null,
    ruleId: sourceId(schedule.rule),
    dueDate: sourceId(typeof schedule.date === 'string' ? schedule.date : schedule.next_date),
    certainty:
      schedule.amountOp === 'is' && sourceInteger(range)
        ? 'exact'
        : schedule.amountOp === 'isapprox' && sourceInteger(range)
          ? 'approximate'
          : schedule.amountOp === 'isbetween' && bounded
            ? 'range'
            : 'unknown',
    amount: sourceInteger(range) ? sourceMoney(range, currency) : null,
    minimum: bounded ? sourceMoney(Math.min(range.num1, range.num2), currency) : null,
    maximum: bounded ? sourceMoney(Math.max(range.num1, range.num2), currency) : null,
    recurrence:
      typeof schedule.date === 'object' && schedule.date !== null
        ? scheduleRecurrenceSchema.parse({
            frequency: schedule.date.frequency,
            interval: schedule.date.interval ?? null,
            patterns:
              schedule.date.patterns?.map((pattern) => ({
                kind: pattern.type.toLowerCase(),
                value: pattern.value,
              })) ?? null,
            start: schedule.date.start,
            endMode: schedule.date.endMode ?? null,
            endOccurrences: schedule.date.endOccurrences ?? null,
            endDate: schedule.date.endDate ?? null,
            skipWeekend: schedule.date.skipWeekend ?? null,
            weekendSolveMode: schedule.date.weekendSolveMode ?? null,
          })
        : null,
  };
}

/** Authoritative Actual amounts plus explicit unknown institution facts; no names/defaults imply liquidity truth. */
export function normalizeActualLiquidityFacts(
  input: ActualLiquidityNormalizationInput,
): LiquidityFacts {
  const asOfMonth = input.capturedAt.slice(0, 7);
  const categories: CategoryLiquidityFact[] = [];
  const categoryById = new Map(input.categories.items.map((category) => [category.id, category]));
  for (const month of input.budgetMonths) {
    if (month.month < asOfMonth) continue;
    for (const group of month.categoryGroups) {
      for (const category of group.categories ?? []) {
        const categoryId = sourceId(category.id);
        if (
          !categoryId ||
          category.is_income === true ||
          categoryById.get(categoryId)?.is_income === true
        )
          continue;
        const current = month.month === asOfMonth;
        // Actual future balance includes rolled current cash; only its new budget assignment is disjoint.
        const sourceAvailability = current ? category.balance : category.budgeted;
        const availabilityKnown = sourceInteger(sourceAvailability);
        categories.push({
          categoryId,
          cashBucketId: `actual:category:${categoryId}:${month.month}`,
          asOfMonth: month.month,
          kind: 'ordinary',
          periodKind: current ? 'current' : 'future',
          availability: sourceMoney(availabilityKnown ? sourceAvailability : 0, input.currency),
          evidence: evidence(
            availabilityKnown ? 'known' : 'unavailable',
            input.capturedAt,
            availabilityKnown
              ? []
              : [
                  current
                    ? 'category_balance_unavailable'
                    : 'future_category_assignment_unavailable',
                ],
          ),
        });
      }
    }
  }
  for (const category of input.categories.items) {
    if (category.is_income === true) continue;
    if (categories.some((fact) => fact.categoryId === category.id && fact.periodKind === 'current'))
      continue;
    categories.push({
      categoryId: category.id,
      cashBucketId: `actual:category:${category.id}:${asOfMonth}`,
      asOfMonth,
      kind: 'ordinary',
      periodKind: 'current',
      availability: sourceMoney(0, input.currency),
      evidence: evidence('unavailable', input.capturedAt, ['current_category_balance_unavailable']),
    });
  }
  const scheduleSources = input.schedules.items
    .filter((schedule) => !schedule.completed)
    .map((schedule) => normalizeActualScheduleLiquiditySource(schedule, input.currency));
  const accounts: AccountLiquidityFact[] = input.accounts.items.map((account) => {
    const transactionRead = input.transactions.find((read) => read.accountId === account.id)?.read;
    const transactions = liveTransactions(transactionRead?.items ?? []);
    const activityUnknown = transactions.some(
      (transaction) =>
        !sourceInteger(transaction.amount) || typeof transaction.cleared !== 'boolean',
    );
    // Clearing a manual transfer is bookkeeping, not proof that incoming cash has arrived.
    const unsettledFlows: UnsettledFlow[] = transactions
      .filter(
        (transaction) =>
          sourceInteger(transaction.amount) &&
          (transaction.cleared !== true ||
            (transaction.amount > 0 &&
              sourceId(transaction.transfer_id) !== null &&
              (sourceId(transaction.imported_id) === null || transaction.reconciled !== true))),
      )
      .map((transaction) => ({
        id: transaction.id,
        economicObligationId: transaction.schedule
          ? `schedule:${transaction.schedule}:${transaction.date}`
          : `transaction:${transaction.id}`,
        direction: transaction.amount < 0 ? 'outflow' : 'inflow',
        amount: sourceMoney(Math.abs(transaction.amount), input.currency),
        includedInBalance: true,
        matchedTransactionIds: [transaction.id],
        scheduleId: sourceId(transaction.schedule),
        transferTransactionId: sourceId(transaction.transfer_id),
        importedId: sourceId(transaction.imported_id),
        reconciled: transaction.reconciled === true,
        provenance: sourceId(transaction.imported_id) ? 'actual_import' : 'manual_ledger',
      }));
    const activityReasons = activityUnknown ? ['transaction_activity_incomplete'] : [];
    if (
      unsettledFlows.some(
        (flow) =>
          flow.direction === 'inflow' &&
          flow.transferTransactionId !== null &&
          (flow.importedId === null || !flow.reconciled),
      )
    ) {
      activityReasons.push('manual_transfer_credit_unverified');
    }
    const obligations: CashObligation[] = [];
    const scheduleReasons: string[] = [];
    for (const schedule of scheduleSources) {
      if (schedule.accountId !== null && schedule.accountId !== account.id) continue;
      if (
        schedule.accountId === null ||
        schedule.certainty !== 'exact' ||
        !schedule.dueDate ||
        !/^\d{4}-\d{2}-\d{2}$/.test(schedule.dueDate)
      ) {
        scheduleReasons.push('schedule_uncertain');
        continue;
      }
      // Recurrence configuration is preserved, but this snapshot normalizer has no evaluation horizon.
      if (schedule.recurrence !== null) scheduleReasons.push('schedule_recurrence_unsupported');
      if (!schedule.amount || !schedule.amount.minorUnits.startsWith('-')) continue;
      const matched = transactions.filter(
        (transaction) =>
          transaction.account === account.id &&
          transaction.schedule === schedule.id &&
          transaction.date === schedule.dueDate,
      );
      let linkedTotal = 0n;
      let clearedTotal = 0n;
      let ambiguous = false;
      const rowIds = new Set<string>();
      const importedIds = new Set<string>();
      for (const transaction of matched) {
        const importedId = sourceId(transaction.imported_id);
        if (
          !sourceInteger(transaction.amount) ||
          transaction.amount >= 0 ||
          rowIds.has(transaction.id) ||
          (importedId !== null && importedIds.has(importedId))
        ) {
          ambiguous = true;
          continue;
        }
        rowIds.add(transaction.id);
        if (importedId !== null) importedIds.add(importedId);
        // Exact source-amount comparison only; capacity and unmatched-cash arithmetic stay in Rust.
        const signedAmount = BigInt(transaction.amount);
        linkedTotal += signedAmount;
        if (transaction.cleared === true) clearedTotal += signedAmount;
      }
      const scheduledTotal = BigInt(schedule.amount.minorUnits);
      if (matched.length > 0 && (ambiguous || linkedTotal !== scheduledTotal)) {
        ambiguous = true;
        scheduleReasons.push('schedule_linked_amount_ambiguous');
      }
      const includedInBalance = matched.length > 0 && !ambiguous && linkedTotal === scheduledTotal;
      obligations.push({
        id: schedule.id,
        economicObligationId: `schedule:${schedule.id}:${schedule.dueDate}`,
        categoryId: null,
        amount: { ...schedule.amount, minorUnits: schedule.amount.minorUnits.slice(1) },
        dueAt: schedule.dueDate,
        paid: includedInBalance && clearedTotal === scheduledTotal,
        includedInBalance,
        matchedTransactionIds: matched.map((transaction) => transaction.id),
      });
    }
    return {
      accountId: account.id,
      currency: input.currency,
      currencyEvidence: evidence('unknown', input.capturedAt, ['account_currency_not_exposed']),
      kind: 'unknown',
      kindEvidence: evidence('unknown', input.capturedAt, ['account_type_not_exposed']),
      onBudget: account.offbudget === false,
      closed: account.closed !== false,
      owned: false,
      ownershipEvidence: evidence('unknown', input.capturedAt, ['account_ownership_not_exposed']),
      recordedBalance: sourceMoney(
        sourceInteger(account.balance_current) ? account.balance_current : 0,
        input.currency,
      ),
      balanceEvidence: evidence(
        sourceInteger(account.balance_current) ? 'known' : 'unavailable',
        input.capturedAt,
        ['ledger_balance_not_institution_freshness'],
      ),
      freshnessEvidence: evidence('unknown', input.capturedAt, [
        'institution_freshness_not_exposed',
      ]),
      activityEvidence: evidence(
        !transactionRead?.available ? 'unavailable' : activityUnknown ? 'unknown' : 'known',
        input.capturedAt,
        activityReasons,
      ),
      scheduleEvidence: evidence(
        !input.schedules.available ? 'unavailable' : scheduleReasons.length ? 'unknown' : 'known',
        input.capturedAt,
        scheduleReasons,
      ),
      baselineTransactionIds: [
        ...new Set(
          transactions.flatMap((transaction) => [
            transaction.id,
            ...(transaction.imported_id ? [transaction.imported_id] : []),
          ]),
        ),
      ].sort(),
      unsettledFlows,
      holds: sourceMoney(0, input.currency),
      holdsEvidence: evidence('unknown', input.capturedAt, ['institution_holds_not_exposed']),
      obligations,
      credit: null,
      ambiguityReasons: [
        ...(!input.categories.available ? ['category_coverage_unavailable'] : []),
        ...(account.offbudget === undefined || account.closed === undefined
          ? ['account_eligibility_unavailable']
          : []),
      ],
    };
  });
  return liquidityFactsSchema.parse({
    version: '1',
    ledgerContentHash: input.ledgerContentHash,
    asOfMonth,
    categories,
    accounts,
    schedules: scheduleSources,
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Internal trusted composition only. Callers must authorize persisted facts, never forward public facts here. */
export function withLiquidityFacts(
  snapshot: FinancialSnapshot,
  facts: LiquidityFacts,
): FinancialSnapshot {
  const liquidity = liquidityFactsSchema.parse(facts);
  liquidity.ledgerContentHash = snapshot.liquidity?.ledgerContentHash ?? snapshot.contentHash;
  const { contentHash: _oldHash, snapshotId: _oldId, ...content } = snapshot;
  const composite = { ...content, liquidity };
  const digest = createHash('sha256').update(canonicalJson(composite)).digest('hex');
  return {
    ...composite,
    contentHash: `sha256:${digest}`,
    snapshotId: `${snapshot.source.ledgerBackend}:${snapshot.source.ledgerId}:${snapshot.source.budgetId}:sha256:${digest}`,
  };
}

const observationTimestamp = factEvidenceSchema.shape.observedAt.unwrap();
/** Values only: caller-supplied source, evidence, provenance, account IDs inside facts, and policy are rejected. */
export const userAttestedLiquidityObservationSchema = z
  .object({
    accountId: z.string().min(1),
    observedAt: observationTimestamp,
    expiresAt: observationTimestamp,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    kind: liquidityAccountKindSchema.optional(),
    owned: z.boolean().optional(),
    currentLedgerConfirmed: z.literal(true).optional(),
    holds: moneySchema.strict().optional(),
    unsettledFlows: z
      .array(unsettledFlowSchema.extend({ provenance: z.literal('manual_ledger') }))
      .optional(),
    obligations: z.array(cashObligationSchema).optional(),
    credit: creditLiquidityFactSchema.omit({ evidence: true }).nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Date.parse(value.expiresAt) > Date.parse(value.observedAt),
    'Observation expiry must follow observation time',
  );

export type UserAttestedLiquidityObservation = z.infer<
  typeof userAttestedLiquidityObservationSchema
>;

/** Stored server-owned binding; the public observation schema deliberately rejects its hash. */
export const persistedUserAttestedLiquidityObservationSchema =
  userAttestedLiquidityObservationSchema
    .innerType()
    .extend({
      ledgerConfirmationHash: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .optional(),
    })
    .strict()
    .refine(
      (value) => Date.parse(value.expiresAt) > Date.parse(value.observedAt),
      'Observation expiry must follow observation time',
    )
    .refine(
      (value) =>
        (value.currentLedgerConfirmed === true) === (value.ledgerConfirmationHash !== undefined),
      'Current ledger confirmation requires a server-owned material binding',
    );

export type PersistedUserAttestedLiquidityObservation = z.infer<
  typeof persistedUserAttestedLiquidityObservationSchema
>;

function ledgerConfirmationHash(
  snapshot: FinancialSnapshot,
  account: AccountLiquidityFact,
): string {
  if (
    account.balanceEvidence.source !== 'actual_ledger' ||
    account.balanceEvidence.state !== 'known'
  ) {
    throw new Error(
      'Current ledger confirmation requires an authoritative available ledger balance',
    );
  }
  const byId = <T extends { id: string }>(items: readonly T[]): T[] =>
    [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const material = {
    source: snapshot.source,
    accountId: account.accountId,
    onBudget: account.onBudget,
    closed: account.closed,
    recordedBalance: account.recordedBalance,
    baselineTransactionIds: [...account.baselineTransactionIds].sort(),
    unsettledFlows: byId(account.unsettledFlows).map((flow) => ({
      ...flow,
      matchedTransactionIds: [...flow.matchedTransactionIds].sort(),
    })),
    obligations: byId(account.obligations).map((obligation) => ({
      ...obligation,
      matchedTransactionIds: [...obligation.matchedTransactionIds].sort(),
    })),
    schedules: byId(
      (snapshot.liquidity?.schedules ?? []).filter(
        (schedule) => schedule.accountId === null || schedule.accountId === account.accountId,
      ),
    ),
    transactions: byId(
      snapshot.legacySnapshot.transactions.filter(
        (transaction) => transaction.accountId === account.accountId,
      ),
    ),
  };
  return `sha256:${createHash('sha256').update('actual-ledger-confirmation-v1\n').update(canonicalJson(material)).digest('hex')}`;
}

/** After resource authorization, bind public values to current source account material before persistence. */
export function bindUserAttestedLiquidityObservations(
  snapshot: FinancialSnapshot,
  observations: readonly UserAttestedLiquidityObservation[],
): PersistedUserAttestedLiquidityObservation[] {
  if (!snapshot.liquidity)
    throw new Error('Ledger liquidity normalization is required before binding observations');
  const facts = liquidityFactsSchema.parse(snapshot.liquidity);
  const seen = new Set<string>();
  return observations.map((candidate) => {
    const observation = userAttestedLiquidityObservationSchema.parse(candidate);
    if (seen.has(observation.accountId))
      throw new Error('Duplicate account supplemental observation');
    seen.add(observation.accountId);
    const account = facts.accounts.find((item) => item.accountId === observation.accountId);
    if (!account) throw new Error('Supplemental observation references an unknown account');
    return persistedUserAttestedLiquidityObservationSchema.parse({
      ...observation,
      ...(observation.currentLedgerConfirmed === true
        ? { ledgerConfirmationHash: ledgerConfirmationHash(snapshot, account) }
        : {}),
    });
  });
}

/** Governed service path: persisted authorized observations stay user_attested and retain explicit expiry, never bank freshness. */
export function mergeUserAttestedLiquidityObservations(
  snapshot: FinancialSnapshot,
  observations: readonly PersistedUserAttestedLiquidityObservation[],
): FinancialSnapshot {
  if (!snapshot.liquidity)
    throw new Error('Ledger liquidity normalization is required before supplemental observations');
  const facts = liquidityFactsSchema.parse(snapshot.liquidity);
  const seen = new Set<string>();
  for (const candidate of observations) {
    const observation = persistedUserAttestedLiquidityObservationSchema.parse(candidate);
    if (seen.has(observation.accountId))
      throw new Error('Duplicate account supplemental observation');
    seen.add(observation.accountId);
    const account = facts.accounts.find((item) => item.accountId === observation.accountId);
    if (!account) throw new Error('Supplemental observation references an unknown account');
    const attested: FactEvidence = {
      state: 'known',
      source: 'user_attested',
      observedAt: observation.observedAt,
      expiresAt: observation.expiresAt,
      reasons: ['explicit_user_attestation_not_bank_sync'],
    };
    if (observation.currentLedgerConfirmed === true) {
      if (observation.ledgerConfirmationHash !== ledgerConfirmationHash(snapshot, account)) {
        throw new Error('Current ledger confirmation does not match account ledger material');
      }
      account.freshnessEvidence = attested;
    }
    if (observation.currency !== undefined) {
      account.currency = observation.currency;
      account.currencyEvidence = attested;
    }
    if (observation.kind !== undefined) {
      account.kind = observation.kind;
      account.kindEvidence = attested;
    }
    if (observation.owned !== undefined) {
      account.owned = observation.owned;
      account.ownershipEvidence = attested;
    }
    if (observation.holds !== undefined) {
      if (
        account.holdsEvidence.state === 'known' &&
        (account.holds.minorUnits !== observation.holds.minorUnits ||
          account.holds.currency !== observation.holds.currency)
      ) {
        throw new Error('Supplemental observation cannot replace existing hold evidence');
      }
      account.holds = observation.holds;
      account.holdsEvidence = attested;
    }
    if (observation.unsettledFlows !== undefined) {
      for (const flow of observation.unsettledFlows) {
        if (
          account.unsettledFlows.some(
            (existing) =>
              existing.id === flow.id ||
              existing.economicObligationId === flow.economicObligationId,
          ) ||
          flow.matchedTransactionIds.some((id) => account.baselineTransactionIds.includes(id))
        ) {
          throw new Error('Supplemental activity cannot replace ledger evidence');
        }
        account.unsettledFlows.push(flow);
      }
      if (observation.unsettledFlows.length > 0 && account.activityEvidence.state === 'known') {
        account.activityEvidence = {
          ...attested,
          reasons: [...account.activityEvidence.reasons, ...attested.reasons],
        };
      }
    }
    if (observation.obligations !== undefined) {
      for (const obligation of observation.obligations) {
        if (
          account.obligations.some(
            (existing) =>
              existing.id === obligation.id ||
              existing.economicObligationId === obligation.economicObligationId,
          ) ||
          obligation.matchedTransactionIds.some((id) => account.baselineTransactionIds.includes(id))
        ) {
          throw new Error('Supplemental obligation cannot replace ledger evidence');
        }
        account.obligations.push(obligation);
      }
      if (account.scheduleEvidence.state === 'known') account.scheduleEvidence = attested;
    }
    if (observation.credit !== undefined) {
      if (observation.credit !== null) {
        const credit = observation.credit;
        const paymentCategories = facts.categories.filter(
          (category) =>
            category.categoryId === credit.paymentCategoryId &&
            category.periodKind === 'current' &&
            category.asOfMonth === facts.asOfMonth,
        );
        const paymentCategory = paymentCategories[0];
        if (
          paymentCategories.length !== 1 ||
          !paymentCategory ||
          (paymentCategory.kind !== 'ordinary' && paymentCategory.kind !== 'credit_payment') ||
          paymentCategory.evidence.state !== 'known' ||
          paymentCategory.evidence.source !== 'actual_ledger'
        ) {
          throw new Error(
            'Credit payment category must be an available current Actual ordinary or payment category',
          );
        }
        if (
          paymentCategory.availability.currency !== account.currency ||
          credit.authorizationAvailable.currency !== account.currency ||
          credit.reservedCash.currency !== account.currency
        ) {
          throw new Error('Credit payment category currency is incompatible');
        }
        if (
          account.kind !== 'credit' ||
          credit.paymentAccountId === account.accountId ||
          !facts.accounts.some((candidate) => candidate.accountId === credit.paymentAccountId)
        ) {
          throw new Error(
            'Credit payment declaration requires a credit account and a distinct existing payment account',
          );
        }
        // The governed declaration establishes purpose, never a replacement for Actual availability evidence.
        for (const category of facts.categories) {
          if (category.categoryId === paymentCategory.categoryId) category.kind = 'credit_payment';
        }
      }
      account.credit =
        observation.credit === null ? null : { ...observation.credit, evidence: attested };
    }
  }
  return withLiquidityFacts(snapshot, facts);
}

/** Trusted Actual reads distinguish imported ledger sides from manual records, never claim provider confirmation. */
export function normalizeActualTransferSettlementRecords(
  transactions: TransactionEntity[],
  observedAt: string,
  currency: string,
): TransferSettlementRecord[] {
  return liveTransactions(transactions)
    .filter((transaction) => sourceId(transaction.transfer_id) && sourceInteger(transaction.amount))
    .map((transaction) => ({
      id: transaction.id,
      accountId: transaction.account,
      amount: sourceMoney(transaction.amount, currency),
      observedAt,
      occurredAt: transaction.date,
      importedId: sourceId(transaction.imported_id),
      providerReference: null,
      pairId: [transaction.id, transaction.transfer_id!].sort().join(':'),
      reconciled: transaction.reconciled === true,
      reversed: false,
      provenance: sourceId(transaction.imported_id) ? 'actual_import' : 'manual_ledger',
    }));
}

import type { Category, Money, Payee, Rule } from './index.js';
import type { ScheduleLiquidityFact } from './liquidity.js';

/** Rust-owned merchant analysis namespace; IDs retain their actual source identity. */
export interface MerchantScope {
  spaceId: string;
  budgetId: string;
  connectionId: string;
}

/** Unavailable means not admitted; unsupported means no SDK field; absent/empty/present describe admitted text. */
export type MerchantTextField =
  | { state: 'unavailable' | 'unsupported' | 'absent'; value: null }
  | { state: 'empty'; value: '' }
  | { state: 'present'; value: string };

/** Completeness of an admitted source collection, not a claim about the entire budget. */
export type MerchantCollectionState = 'complete' | 'partial' | 'unavailable';

/** Canonical source-field availability vocabulary. */
export type MerchantTextState = 'unavailable' | 'unsupported' | 'absent' | 'empty' | 'present';
/** Whether source currency is established. */
export type MerchantCurrencyState = 'known' | 'unknown';
/** Pending-activity source admission capability. */
export type MerchantPendingState = 'unsupported' | 'included' | 'excluded';
/** Attributed alias decision vocabulary. */
export type MerchantAliasState = 'accepted' | 'rejected';
/** Independently admitted correction state. */
export type MerchantCorrectionState = 'confirmed' | 'revoked';
/** Durable pattern decision vocabulary. */
export type MerchantPatternState = 'accepted' | 'rejected' | 'revoked';
/** Signed minor-unit direction. */
export type MerchantDirection = 'inflow' | 'outflow' | 'zero';
/** Observed cadence vocabulary, independent of source schedules. */
export type MerchantFrequency = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual' | 'multiple' | 'irregular';
/** Observed recurrences only; schedules have their own source-faithful records. */
export type MerchantRecurrenceKind = 'observed';
/** Provenance classes that never assert financial execution. */
export type MerchantEvidenceKind = 'source_observation' | 'normalized_evidence' | 'confirmed_decision' | 'native_rule' | 'semantic_suggestion';

/** Completeness of each authoritative source collection. */
export interface MerchantCollections {
  transactions: MerchantCollectionState;
  payees: MerchantCollectionState;
  categories: MerchantCollectionState;
  rules: MerchantCollectionState;
  schedules: MerchantCollectionState;
}

/** History and currency coverage for one admitted source account. */
export interface MerchantAccountCoverage {
  accountId: string;
  state: MerchantCollectionState;
  startDate: string;
  endDate: string;
  currencyState: MerchantCurrencyState;
}

/** Full provenance/dependency closure retained independently of bounded explanation samples. */
export interface MerchantSourceAdmission {
  capturedAt: string;
  factsHash: string;
  expiresAt: string;
  collections: MerchantCollections;
  accountCoverage: MerchantAccountCoverage[];
  pendingState: MerchantPendingState;
  originalTransactionCount: number;
  truncatedCount: number;
  visibilityHash: string;
  sourceAccountIds: string[];
  sourceCategoryIds: string[];
}

/** Flattened source observation; split completeness is established before actor projection. */
export interface MerchantTransaction {
  id: string;
  accountId: string;
  date: string;
  payeeId: string | null;
  payeeName: string | null;
  categoryId: string | null;
  amount: Money;
  cleared: boolean;
  reconciled: boolean;
  importedId: string | null;
  importedPayee: MerchantTextField;
  description: MerchantTextField;
  verboseTitle: MerchantTextField;
  notes: MerchantTextField;
  isSplitParent: boolean;
  isSplitChild: boolean;
  parentId: string | null;
  occurrenceId: string;
  occurrenceComplete: boolean;
  startingBalance: boolean;
  transferAccountId: string | null;
  deleted: boolean;
  pending: boolean;
}

/** Aliasable native payee name or raw source field; never a monetary identity assertion or native-ID replacement. */
export type MerchantSourceField = 'payeeName' | 'importedPayee' | 'description' | 'verboseTitle' | 'notes';

/** Attributed source-field alias decision; accepted aliases cannot replace native payee identity. */
export interface MerchantAlias {
  id: string;
  sourceText: string;
  sourceField: MerchantSourceField;
  targetPayeeId: string;
  accountId: string | null;
  state: MerchantAliasState;
  actorId: string;
  version: number;
  updatedAt: string;
  sourceTransactionIds: string[];
}

/** Independently verified category correction; revocation never becomes a training label. */
export interface MerchantCorrection {
  transactionId: string;
  payeeId: string | null;
  accountId: string;
  categoryId: string;
  state: MerchantCorrectionState;
  verified: boolean;
  actorId: string;
  version: number;
}

/** A selected public holiday does not establish that a particular bank was closed. */
export interface MerchantHoliday {
  date: string;
  name: string;
}

/** Explicit civil-date calendar; jurisdiction is never inferred from currency. */
export interface MerchantCalendar {
  accountId: string | null;
  jurisdiction: string;
  subdivision: string | null;
  timeZone: string;
  version: string;
  coverageStart: string;
  coverageEnd: string;
  holidays: MerchantHoliday[];
}

/** Source-faithful scheduled expectation input, separate from observed cadence. */
export interface MerchantSchedule {
  payeeId: string | null;
  source: ScheduleLiquidityFact;
}

/** Attributed user intent concerning a stable pattern, not confirmation of ledger execution. */
export interface MerchantPatternDecision {
  id: string;
  patternId: string;
  state: MerchantPatternState;
  actorId: string;
  version: number;
  updatedAt: string;
}

/** Bounded suggestion selection; admitted transaction IDs are sorted lexically, cursor exclusive. */
export interface MerchantSuggestionSelection {
  transactionIds: string[];
  cursor: string | null;
  limit: number;
}

/** Canonical merchant/2 analysis input over already-authorized immutable source facts. */
export interface MerchantAnalysisRequest {
  schemaVersion: '1';
  scope: MerchantScope;
  snapshotId: string;
  asOfDate: string;
  normalizationVersion: 'merchant/2';
  sourceAdmission: MerchantSourceAdmission;
  transactions: MerchantTransaction[];
  payees: Payee[];
  categories: Category[];
  rules: Rule[];
  aliases: MerchantAlias[];
  corrections: MerchantCorrection[];
  schedules: MerchantSchedule[];
  patternDecisions: MerchantPatternDecision[];
  calendars: MerchantCalendar[];
  horizonYears: number;
  maxEvidence: number;
  suggestionSelection?: MerchantSuggestionSelection;
}

/** Confidence semantics, not a calibrated probability or authorization grant. */
export type MerchantEvidenceTier = 'confirmed' | 'deterministic_match' | 'inferred' | 'insufficient_data' | 'conflicting';

/** Locally attributed supporting or contradictory semantic evidence. */
export interface MerchantEvidence {
  kind: MerchantEvidenceKind;
  sourceId: string;
  field: string | null;
  rawText: string | null;
  normalizedText: string | null;
  sourceTime: string | null;
  version: string;
  reasonCode: string;
}

/** Full native category outcome counts, independently of bounded evidence samples. */
export interface MerchantCategoryHistoryEntry {
  categoryId: string;
  count: number;
  firstDate: string;
  lastDate: string;
  ledgerCount: number;
  correctionCount: number;
}

/** Selected category first, then ranked entries; totals retain every admitted outcome. */
export interface MerchantCategoryHistory {
  totalCount: number;
  categoryCount: number;
  entries: MerchantCategoryHistoryEntry[];
  truncated: boolean;
}

/** Competing current evidence; semantic tiers are not calibrated probabilities. */
export interface MerchantAlternative {
  categoryId: string;
  supportCount: number;
  tier: MerchantEvidenceTier;
  reasonCodes: string[];
}

/** Stable native payee history advice, not a rule payload or execution permission. */
export interface MerchantRuleCandidate {
  payeeId: string;
  categoryId: string;
  supportCount: number;
  consistencyNumerator: number;
  consistencyDenominator: number;
}

/** Complete unique IDs for one compiled matching predicate/category; blocks are disjoint. */
export interface MerchantNativeRuleBlock {
  ruleIds: string[];
}

/** Frozen literal posting; membership may overlap other parts. */
export interface MerchantNativeRulePart {
  blockIndexes: number[];
}

/** Category-filtered union of OR parts and the four fixed AND field operands. */
export interface MerchantNativeRuleSet {
  orPartIndexes: number[];
  andPartIndexes: number[][];
  categoryPartIndex: number;
}

/** Every surviving uncategorized native rule outcome, independent of explanation selection. */
export interface MerchantNativeRuleClassification {
  transactionId: string;
  accountId: string;
  categoryId: string;
  ruleSetIndex: number;
}

/** Complete actionable non-native category targets, independent of explanation selection. */
export interface MerchantCategoryClassification {
  transactionId: string;
  accountId: string;
  payeeId: string | null;
  categoryId: string;
  tier: 'confirmed' | 'inferred';
  evidenceRevision: string;
}

/** Explainable identity/category suggestion, not a mutation or execution record. */
export interface MerchantSuggestion {
  transactionId: string;
  accountId: string;
  payeeId: string | null;
  categoryId: string | null;
  tier: MerchantEvidenceTier;
  reasonCodes: string[];
  evidence: MerchantEvidence[];
  contradictions: MerchantEvidence[];
  supportCount: number;
  evidenceRevision: string;
  categoryHistory: MerchantCategoryHistory;
  alternatives: MerchantAlternative[];
  ruleCandidates: MerchantRuleCandidate[];
}

/** Full contiguous period counts, occurrence-count histogram, and reduced exact average. */
export interface MerchantOccurrenceDistribution {
  periodCounts: Record<string, number>;
  countDistribution: Record<string, number>;
  averageNumerator: string;
  averageDenominator: string;
}

/** Effective pattern review state; revocation restores unreviewed current analysis. */
export type MerchantDecisionState = 'unreviewed' | 'accepted' | 'rejected';

/** Observed cadence/statistics; bounded evidence samples never truncate full distributions. */
export interface MerchantRecurrence {
  id: string;
  accountId: string;
  payeeId: string | null;
  normalizedMerchant: string;
  currency: string;
  direction: MerchantDirection;
  tier: MerchantEvidenceTier;
  kind: MerchantRecurrenceKind;
  frequency: MerchantFrequency;
  occurrences: number;
  /** Earliest civil date across all admitted observations, never inferred from bounded samples. */
  firstDate: string;
  /** Latest civil date across all admitted observations, never inferred from bounded samples. */
  lastDate: string;
  transactionIds: string[];
  dates: string[];
  intervalDays: number[];
  intervalDistribution: Record<string, number>;
  dayOfMonth: Record<string, number>;
  dayOfWeek: Record<string, number>;
  monthOfYear: Record<string, number>;
  yearDistribution: Record<string, number>;
  occurrencesPerWeek: MerchantOccurrenceDistribution;
  occurrencesPerMonth: MerchantOccurrenceDistribution;
  occurrencesPerYear: MerchantOccurrenceDistribution;
  minimumAmount: Money;
  maximumAmount: Money;
  varianceNumerator: string | null;
  varianceDenominator: string | null;
  reasonCodes: string[];
  calendarVersion: string | null;
  evidenceRevision: string;
  decisionState: MerchantDecisionState;
}

/** Scheduled source expectation without invented observed intervals or amount variance. */
export interface MerchantScheduledExpectation {
  id: string;
  payeeId: string | null;
  source: ScheduleLiquidityFact;
  reasonCodes: string[];
  decisionState: MerchantDecisionState;
}

/** Admitted analysis coverage, including explicit exclusions and limitations. */
export interface MerchantCoverage {
  startDate: string | null;
  endDate: string | null;
  inputCount: number;
  eligibleCount: number;
  excludedCount: number;
  limited: boolean;
  reasonCodes: string[];
}

/** Suggestion pagination metadata; aggregates still cover all admitted observations. */
export interface MerchantSuggestionPage {
  eligibleCandidates: number;
  returned: number;
  nextCursor: string | null;
}

/** Canonical Rust analysis output preserving source admission and separate observed/scheduled findings. */
export interface MerchantAnalysisResult {
  schemaVersion: '1';
  scope: MerchantScope;
  snapshotId: string;
  normalizationVersion: 'merchant/2';
  sourceAdmission: MerchantSourceAdmission;
  coverage: MerchantCoverage;
  suggestions: MerchantSuggestion[];
  recurrences: MerchantRecurrence[];
  scheduledExpectations: MerchantScheduledExpectation[];
  nativeRuleBlocks: MerchantNativeRuleBlock[];
  nativeRuleParts: MerchantNativeRulePart[];
  nativeRuleSets: MerchantNativeRuleSet[];
  nativeRuleClassifications: MerchantNativeRuleClassification[];
  categoryClassifications: MerchantCategoryClassification[];
  suggestionPage?: MerchantSuggestionPage;
}

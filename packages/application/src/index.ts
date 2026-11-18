/**
 * @balanceframe/application — Application orchestration layer.
 *
 * Coordinates CLI-to-analysis routing, envelope wrapping, and lifecycle
 * operations. No model invocation — all analysis uses injected
 * adapter/protocol values.
 */

export * from './envelope.js';
export * from './errors.js';
export * from './commands.js';
export * from './mutation.js';
export * from './rule-mutation.js';
export * from './analysis.js';
export * from './composition.js';
export * from './connection-manager.js';
export * from './notifications.js';
export * from './review-persistence.js';
export * from './liquidity-public.js';
export * from './liquidity-service.js';
export {
  ConsequentialActionService,
  createConsequentialActionService,
  loadConsequentialActionNative,
} from './consequential-action.js';
export type {
  ConsequentialActionCompositionOptions,
  ConsequentialActionDecisionContext,
  ConsequentialActionDecisionItem,
  ConsequentialActionExecution,
  ConsequentialActionNative,
  ConsequentialActionProposal,
  ConsequentialActionPublicEvidenceReference,
  ConsequentialActionPublicPlan,
  ConsequentialActionPublicSource,
  ConsequentialActionServiceOptions,
} from './consequential-action.js';
export * from './liquidity-inputs.js';
export { LiquidityProjector } from './liquidity-projector.js';
export * from './merchant-service.js';
export * from './merchant-calendar.js';
export * from './merchant-research.js';
export * from './merchant-settings.js';
export * from './merchant-public.js';

export type {
  DecisionContext,
  ProspectiveClaim,
  ProspectiveDecisionEnvelope,
  PurchaseEvaluation,
  RedactionState,
} from '@balanceframe/protocol-generated';

export * from './transaction-evidence.js';

export {
  evidenceItemRuleInputSchema,
  evidenceItemRuleDecisionSchema,
} from './evidence-item-rules.js';
export type { EvidenceItemSuggestion } from './evidence-item-rules.js';

export { manualReceiptPhotoExtractionSchema, parseManualReceiptPhoto } from './receipt-photo.js';

export {
  SpendSessionReceiptService,
  spendSessionReceiptSelectorSchema,
  spendSessionReceiptCompareSchema,
  spendSessionReceiptSaveSchema,
} from './spend-session-receipt.js';

export {
  evidenceSettlementPreviewSchema,
  evidenceSettlementSaveSchema,
  evidenceSettlementTargetsInputSchema,
} from './evidence-settlement.js';

export {
  receiptAnnotationInputSchema,
  receiptReviewSaveSchema,
} from './evidence-receipt-annotations.js';

export {
  evidenceAllocationPreviewSchema,
  evidenceAllocationSaveSchema,
} from './evidence-allocation.js';

export {
  walletStatementPreviewInputSchema,
  walletStatementAttestInputSchema,
  walletStatementRevokeInputSchema,
  walletMaterializationSelectorSchema,
} from './wallet-statement.js';

export * from './evidence-receipt-version.js';

export * from './receipt-item-inference.js';
export * from './decision-card-explanation.js';

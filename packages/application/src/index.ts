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
export * from './liquidity-inputs.js';
export { LiquidityProjector } from './liquidity-projector.js';

export type {
  DecisionContext,
  ProspectiveClaim,
  ProspectiveDecisionEnvelope,
  PurchaseEvaluation,
  RedactionState,
} from '@balanceframe/protocol-generated';

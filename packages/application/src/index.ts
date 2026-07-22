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

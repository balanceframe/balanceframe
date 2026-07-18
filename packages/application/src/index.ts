/**
 * @balanceframe/application — Application orchestration layer.
 *
 * Coordinates CLI-to-analysis routing, envelope wrapping, and lifecycle
 * operations. No model invocation — all analysis uses injected
 * adapter/protocol values.
 */

export * from './envelope';
export * from './errors';
export * from './commands';
export * from './analysis';

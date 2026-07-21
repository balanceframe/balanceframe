/**
 * Live Actual integration tests require persisted cloud metadata.
 *
 * Vitest otherwise forces NODE_ENV=test in worker processes, which makes the
 * Actual API intentionally keep budget sync identity only in memory.
 */
process.env.NODE_ENV = 'production';

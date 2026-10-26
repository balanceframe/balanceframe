/**
 * Live Actual integration tests require persisted cloud metadata.
 *
 * Vitest otherwise forces NODE_ENV=test in worker processes, which makes the
 * Actual API intentionally keep budget sync identity only in memory.
 */
process.env.NODE_ENV = 'production';

const expectedVersion = process.env.ACTUAL_EXPECTED_SERVER_VERSION;
if (expectedVersion !== undefined) {
  if (expectedVersion.trim().length === 0) {
    throw new Error('ACTUAL_EXPECTED_SERVER_VERSION must be non-empty when supplied.');
  }

  const { assertFixtureProvenance } = await import('./helpers.js');
  const { serverURL } = assertFixtureProvenance();
  const response = await fetch(new URL('/info', serverURL), {
    signal: AbortSignal.timeout(5_000),
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error(`Actual fixture /info returned HTTP ${response.status}.`);
  }

  const info: unknown = await response.json();
  const build = typeof info === 'object' && info !== null && 'build' in info
    ? info.build
    : undefined;
  if (
    typeof build !== 'object' || build === null ||
    !('name' in build) || build.name !== '@actual-app/sync-server' ||
    !('version' in build) || typeof build.version !== 'string' || build.version.length === 0
  ) {
    throw new Error('Actual fixture /info must identify @actual-app/sync-server build metadata.');
  }
  if (build.version !== expectedVersion) {
    throw new Error(
      `Actual fixture server version mismatch: expected ${expectedVersion}, received ${build.version}.`,
    );
  }
}

export {};

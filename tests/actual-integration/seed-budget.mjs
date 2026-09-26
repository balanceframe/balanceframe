import { readFileSync } from 'node:fs';

import { canonicalProtocolSnapshotSchema } from '../../packages/protocol-generated/src/validators.ts';
import { seedActualBudget } from '../../packages/scenario-kit/src/actual-seed.ts';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readCanonicalFixture(fixturePath) {
  let raw;
  try {
    raw = readFileSync(fixturePath, 'utf8');
  } catch (error) {
    throw new Error(
      `Unable to read fixture "${fixturePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Unable to parse fixture JSON "${fixturePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    return canonicalProtocolSnapshotSchema.parse(value);
  } catch (error) {
    throw new Error(
      `Fixture "${fixturePath}" is not a canonical ProtocolSnapshot: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

async function main() {
  const fixturePath = requiredEnv('FIXTURE_DATA_PATH');
  const result = await seedActualBudget({
    serverUrl: requiredEnv('ACTUAL_SERVER_URL'),
    secretKey: requiredEnv('ACTUAL_SECRET_KEY'),
    clientDir: requiredEnv('SEED_DATA_DIR'),
    budgetName: requiredEnv('ACTUAL_BUDGET_NAME'),
    ledger: readCanonicalFixture(fixturePath),
  });

  process.stdout.write(
    `${JSON.stringify({
      status: 'seeded',
      budgetId: result.budgetId,
      groupId: result.groupId,
      budgetName: result.budgetName,
      serverUrl: process.env.ACTUAL_SERVER_URL,
      accountIds: result.accountIds,
      categoryGroupIds: result.categoryGroupIds,
      categoryIds: result.categoryIds,
      payeeIds: result.payeeIds,
      transactionIds: result.transactionIds,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })}\n`,
  );
  process.exitCode = 1;
});

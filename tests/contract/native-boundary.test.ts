import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'vitest';
import { actualLiquidityRequest } from './fixtures/actual-liquidity.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

describe('real Node/N-API normalized Actual contracts', () => {
  it('preserves attested cash, income classification and credit payment reserves', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'balanceframe-native-contract-'));
    try {
      const plain = path.join(directory, 'plain.json');
      const attested = path.join(directory, 'attested.json');
      const card = path.join(directory, 'card.json');
      writeFileSync(plain, JSON.stringify(actualLiquidityRequest(false)));
      writeFileSync(attested, JSON.stringify(actualLiquidityRequest(true)));
      writeFileSync(card, JSON.stringify(actualLiquidityRequest(true, true)));
      for (const [script, ...args] of [
        ['crates/node-binding/test/account-aware-liquidity.mjs', plain, attested],
        ['tests/contract/actual-income-native.mjs', attested],
        ['tests/contract/actual-card-native.mjs', card],
      ]) {
        execFileSync(process.execPath, [path.join(root, script!), ...args], {
          cwd: root,
          env: process.env,
          stdio: 'pipe',
        });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

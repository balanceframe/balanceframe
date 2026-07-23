// @balanceframe/native smoke test
//
// Tests that the native binary loads, exports expected functions, and
// that analyzeDeterministic works end-to-end.
// Also verifies clear failure behavior when the binary is absent.
//
// Loads the artifact directly from the package root.  Package-name
// resolution (@balanceframe/native) is verified from a consumer scope.
//
// Usage:
//   node test/smoke.mjs           # from crates/node-binding/

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const BINARY_PATH = path.join(PKG_ROOT, 'balanceframe.node');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}`);
  }
}

function assertThrows(fn, label) {
  try {
    fn();
    failed++;
    console.error(`  FAIL  ${label} (expected error)`);
  } catch (e) {
    passed++;
    console.log(`  PASS  ${label} — ${e.message.split('\n')[0]}`);
  }
}

// ---------------------------------------------------------------------------
// Helper: minimal valid input for analyzeDeterministic
// ---------------------------------------------------------------------------
function makeAnalyzeInput() {
  return JSON.stringify({
    snapshot: {
      schemaVersion: '1.0',
      actualVersion: '25.1.0',
      snapshotDate: '2026-07-18',
      accounts: [],
      transactions: [],
      categories: [],
      payees: [],
      rules: [],
      schedules: [],
      budgets: [],
      tags: [],
      actualDownloadedAt: null,
      encrypted: null,
      bankSyncedAt: null,
    },
    options: {
      includePending: true,
      includeCleared: true,
      maxResults: 10,
    },
    requestId: 'smoke-test',
    actorId: null,
  });
}

// ---------------------------------------------------------------------------
// 0. Binary artifact exists
// ---------------------------------------------------------------------------
console.log('\n0. Artifact presence');
assert(fs.existsSync(BINARY_PATH), `balanceframe.node exists at ${BINARY_PATH}`);

// ---------------------------------------------------------------------------
// 1. Clear failure when artifact is absent
// ---------------------------------------------------------------------------
console.log('\n1. Failure behavior when absent');
{
  const missingPath = path.join(PKG_ROOT, '__does_not_exist.node');
  assertThrows(() => {
    createRequire(import.meta.url)(missingPath);
  }, 'loading missing .node file throws descriptive error');
}

// ---------------------------------------------------------------------------
// 2. Module loads via direct path
// ---------------------------------------------------------------------------
console.log('\n2. Module loading');
let native;
try {
  native = createRequire(import.meta.url)(BINARY_PATH);
  assert(typeof native === 'object' && native !== null, 'loads and returns object');
} catch (e) {
  assert(false, `load failed: ${e.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Expected exports exist
// ---------------------------------------------------------------------------
console.log('\n3. Exports');
const expectedExports = [
  'analyzeDeterministic',
  'analyzeSnapshot',
  'findCategorizationCandidates',
  'validateSuggestion',
  'validateProviderSuggestion',
  'planSetCategory',
  'verifyMutation',
  'simulateRule',
  'planCreateRule',
  'verifyRuleMutation',
  'analyzeRuleCandidates',
];
for (const name of expectedExports) {
  assert(typeof native[name] === 'function', `${name} is exported`);
}

// ---------------------------------------------------------------------------
// 4. analyzeDeterministic works end-to-end
// ---------------------------------------------------------------------------
console.log('\n4. analyzeDeterministic invocation');
try {
  const result = native.analyzeDeterministic(makeAnalyzeInput());
  assert(typeof result === 'string', 'returns a string');
  const parsed = JSON.parse(result);
  assert(typeof parsed === 'object', 'result is valid JSON');
  assert(typeof parsed.schemaVersion === 'string', 'result has schemaVersion');
  assert(typeof parsed.requestId === 'string', 'result has requestId');
  assert(parsed.requestId === 'smoke-test', 'requestId round-trips');
  console.log(`  INFO  status=${parsed.status}  freshness=${JSON.stringify(parsed.freshness)}  coverage=${JSON.stringify(parsed.coverage)}`);
} catch (e) {
  assert(false, `analyzeDeterministic: ${e.message}`);
}

// ---------------------------------------------------------------------------
// 5. Invalid input produces a clear error (not a crash)
// ---------------------------------------------------------------------------
console.log('\n5. Error handling');
assertThrows(() => {
  native.analyzeDeterministic('not valid json at all');
}, 'malformed JSON raises descriptive error');

assertThrows(() => {
  native.analyzeDeterministic('{"bad": "input"}');
}, 'invalid input shape raises descriptive error');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- Result: ${passed} passed, ${failed} failed ---\n`);
process.exit(failed > 0 ? 1 : 0);

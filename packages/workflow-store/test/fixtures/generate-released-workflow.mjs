import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Run manually from an installed checkout; ordinary tests use the frozen SQL only.
const releaseName = process.argv[2] ?? 'v0.8.0';
const release = { 'v0.4.0': '7b26e44c6df9de3d5beedb59d888e43f19381860', 'v0.8.0': '59743bc1b5aa35310f98a2d148eda12a49231c88' }[releaseName];
assert(release, 'Expected v0.4.0 or v0.8.0');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');
const execute = promisify(execFile);
const temporary = mkdtempSync(join(tmpdir(), 'balanceframe-released-fixture-'));
const RealDate = Date;
const realUUID = crypto.randomUUID;
let clock = '2026-10-01T12:00:00.000Z';
let sequence = 0;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return RealDate.parse(clock); }
};
crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
syncBuiltinESMExports();
let store;
try {
  const archive = join(temporary, 'release.tar');
  await execute('git', ['archive', '-o', archive, release, 'packages/workflow-store/src', 'packages/protocol-generated/src', 'protocol/fixtures/representative.json'], { cwd: root });
  await execute('tar', ['-xf', archive, '-C', temporary]);
  const compile = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) compile(path);
      else if (entry.name.endsWith('.ts')) writeFileSync(path.replace(/\.ts$/, '.js'), ts.transpileModule(readFileSync(path, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true },
        fileName: path,
      }).outputText);
    }
  };
  for (const name of ['workflow-store', 'protocol-generated']) compile(join(temporary, 'packages', name, 'src'));
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ type: 'module' }));
  const modules = join(temporary, 'node_modules');
  mkdirSync(join(modules, '@balanceframe'), { recursive: true });
  for (const name of ['better-sqlite3', 'zod']) symlinkSync(dirname(require.resolve(`${name}/package.json`)), join(modules, name));
  const protocol = join(temporary, 'packages/protocol-generated');
  writeFileSync(join(protocol, 'package.json'), JSON.stringify({ type: 'module', exports: { '.': './src/index.js', './validators': './src/validators.js' } }));
  symlinkSync(protocol, join(modules, '@balanceframe/protocol-generated'));

  const { SqliteWorkflowStore } = await import(pathToFileURL(join(temporary, 'packages/workflow-store/src/store.js')).href);
  const fixture = JSON.parse(readFileSync(join(temporary, 'protocol/fixtures/representative.json'), 'utf8'));
  const transaction = fixture.transactions[0];
  const categoryId = fixture.categories[1].id;
  const budgetId = 'synthetic-upgrade-budget';
  const owner = 'synthetic-owner';
  const approver = 'synthetic-former-approver';
  const auth = (actorId) => ({ method: 'human-session', actorId, sessionId: `synthetic-session:${actorId}`, reauthenticatedAt: clock });
  const dbPath = join(temporary, 'workflow.db');
  store = new SqliteWorkflowStore(dbPath);
  if (releaseName === 'v0.4.0') {
    const expiresAt = '2027-01-01T12:00:00.000Z';
    const amount = { ...transaction.amount, minorUnits: BigInt(transaction.amount.minorUnits).toString().replace('-', '') };
    await store.upsertActorMembership(owner, 'active', ['liquidity:policy', 'liquidity:session', 'liquidity:category', 'liquidity:liquidity'], `budget:${budgetId}`);
    for (const [capability, resourceKind, resourceId] of [['policy', 'budget', budgetId], ['session', 'budget', budgetId], ['category', 'category', categoryId], ['liquidity', 'account', transaction.accountId]]) {
      store.liquidity.setResourceGrant({ actorId: owner, budgetId, capability, resourceKind, resourceId, granted: true, now: clock });
    }
    store.liquidity.savePolicy({ actorId: owner, budgetId, expectedVersion: null, now: clock, policy: { version: '1', policyHash: 'synthetic-policy', expiresAt, accounts: [], transferRoutes: [] }, approvalPolicy: { minimumApprovers: 1 } });
    store.liquidity.saveSpendSession({ actorId: owner, budgetId, id: 'synthetic-legacy-session', expectedVersion: 0, idempotencyKey: 'synthetic-legacy-session-save', now: clock, expiresAt, accountId: transaction.accountId, items: [{ id: 'synthetic-item', categoryId, amount, purchaseAt: clock, requiredBy: expiresAt, routeSelection: { explicitAccountId: null, sessionAccountId: transaction.accountId, approvedPreference: null, historicalRoute: null } }], expectedClaimSetRevision: '0', claim: { id: 'synthetic-legacy-claim', creationSnapshotId: 'synthetic-release-snapshot', creationPolicyVersion: '1', state: 'active', expiresAt, initiated: false, effects: [{ kind: 'category', resourceId: categoryId, amount, economicObligationId: 'synthetic-legacy-obligation', categoryId, includedInBalance: false, matchedTransactionIds: [] }] } }, () => ({ valid: true }));
    await store.saveSuggestion({ transactionId: transaction.id, budgetId, categoryId, classifier: 'synthetic-upgrade', promptVersion: releaseName, payload: { synthetic: true }, transactionVersion: 1 });
    assert.equal(store['db'].prepare('SELECT COUNT(*) AS count FROM liquidity_claims').get().count, 1);
    assert.equal(store['db'].prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='liquidity_claim_metadata'").get().count, 0);
  } else {
  const { deriveProposalAuthorizationFacts, GENERIC_MUTATION_POLICY_VERSION } = await import(pathToFileURL(join(temporary, 'packages/workflow-store/src/proposal.js')).href);
  await store.claimBootstrap({ name: 'Synthetic Owner', email: 'owner@example.test', claimId: 'synthetic-bootstrap' });
  await store.finalizeBootstrap({ claimId: 'synthetic-bootstrap', ownerUserId: owner });
  await store.upsertActorMembership(approver, 'active', [], '');
  const space = store.governance.createSpace({ actorId: owner, name: 'Synthetic Upgrade Space', kind: 'shared', now: clock, auth: auth(owner) });
  store.governance.bindBudget({ spaceId: space.id, budgetId, now: clock, auth: auth(owner) });
  const ownerMembership = store.governance.getCurrentMembership({ spaceId: space.id, actorId: owner, now: clock });
  const formerMembership = store.governance.addMembership({ spaceId: space.id, actorId: approver, validFrom: clock, now: clock, auth: auth(owner) });
  const payload = { kind: 'set_category', transactionId: transaction.id, categoryId };
  const preconditions = { transactionId: transaction.id, accountId: transaction.accountId, currentCategoryId: transaction.categoryId, direction: 'outgoing', amount: { ...transaction.amount, minorUnits: BigInt(transaction.amount.minorUnits).toString().replace('-', '') }, actualVersion: fixture.actualVersion };
  const resources = [{ resourceKind: 'budget', resourceId: budgetId }, ...deriveProposalAuthorizationFacts('set_category', payload, preconditions).resources];
  for (const resource of resources) {
    for (const [actorId, membershipId, capability] of [[owner, ownerMembership.id, 'categorization:propose'], [approver, formerMembership.id, 'categorization:approve']]) {
      store.governance.setResourceGrant({ spaceId: space.id, budgetId, actorId, membershipId, capability, ...resource, granted: true, now: clock, auth: auth(owner) });
    }
  }
  const proposal = await store.createProposal({ operation: 'set_category', spaceId: space.id, budgetId, payload, preconditions: JSON.stringify(preconditions), actorId: owner, auth: auth(owner), policyVersion: GENERIC_MUTATION_POLICY_VERSION, expiresAt: '2026-10-02T12:00:00.000Z', provenance: 'synthetic-upgrade-fixture' });
  await store.createApproval({ proposalId: proposal.id, payloadHash: proposal.payloadHash, actorId: approver, auth: auth(approver), now: clock, expiresAt: proposal.expiresAt });
  const suggestion = await store.saveSuggestion({ transactionId: transaction.id, budgetId, categoryId, classifier: 'synthetic-upgrade', promptVersion: 'v0.8.0', payload: { synthetic: true }, transactionVersion: 1 });
  await store.createReviewItem({ suggestionId: suggestion.id, transactionId: transaction.id, budgetId, categoryId, classifier: 'synthetic-upgrade', provenance: 'synthetic-upgrade-fixture' });
  await store.createSavedView({ authority: { actorId: owner, spaceId: space.id, budgetId, membershipId: ownerMembership.id }, name: 'Synthetic Upgrade View', viewType: 'pending_review', scope: { categoryId } });
  await store.createIdempotencyRecord({ idempotencyKey: 'synthetic-completed-execution', proposalId: proposal.id, operation: 'set_category', serialisedEffect: JSON.stringify(payload) });
  await store.completeIdempotencyRecord('synthetic-completed-execution', null, false, '{"synthetic":true,"verified":true}');
  store.governance.revokeMembership({ spaceId: space.id, membershipId: formerMembership.id, now: clock, auth: auth(owner) });
  await store.upsertActorMembership(approver, 'inactive', [], '');
  clock = '2026-10-03T12:00:00.000Z';
  assert.deepEqual(await store.findActiveApprovals(proposal.id), []);
  }
  store.close();
  store = new SqliteWorkflowStore(dbPath);
  const version = releaseName === 'v0.4.0' ? 11 : 27;
  assert.equal(store['db'].prepare('SELECT MAX(version) AS version FROM schema_version').get().version, version);
  if (releaseName === 'v0.8.0') assert.equal((await store.getIdempotencyRecord('synthetic-completed-execution')).status, 'succeeded');
  store.close();
  store = undefined;
  const { stdout: sql } = await execute('python3', ['-c', 'import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nprint("\\n".join(c.iterdump()))\nc.close()', dbPath], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const header = `-- Synthetic persisted store produced by BalanceFrame ${releaseName} (${release}).\n-- Do not regenerate from current migrations; see README.md.\n`;
  const output = header + sql;
  writeFileSync(new URL(`./${releaseName}-workflow.sql`, import.meta.url), output);
  console.log(`${releaseName} schema=${version} sha256=${crypto.createHash('sha256').update(output).digest('hex')}`);
} finally {
  store?.close();
  globalThis.Date = RealDate;
  crypto.randomUUID = realUUID;
  syncBuiltinESMExports();
  rmSync(temporary, { recursive: true, force: true });
}

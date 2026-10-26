import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// An alternate built artifact supports red/green checks without rebuilding or modifying it.
const server = process.env.BALANCEFRAME_ZOD_PRODUCTION_SERVER || resolve(import.meta.dirname, '../../apps/web/.output/server');
const chunks = join(server, 'chunks');
const files = readdirSync(chunks, { recursive: true });
const compiled = new Map(files.filter((file) => file.endsWith('.mjs')).map((file) => {
  const path = join(chunks, file);
  return [path, ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)];
}));

test('production server chunks do not collapse declared Zod majors into a bare external import', () => {
  const ambiguous = [...compiled].filter(([, source]) => source.statements.some((statement) =>
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier && /^zod(?:\/|$)/.test(statement.moduleSpecifier.text))).map(([file]) => file);
  assert.deepEqual(ambiguous, []);
});

function variable(source, name) {
  const declaration = source.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations).find((item) => item.name.getText(source) === name);
  assert.ok(declaration, `compiled declaration ${name}`);
  return declaration;
}

function schemaFactory(schema) {
  let call = schema.initializer;
  while (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) call = call.expression.expression;
  assert.ok(ts.isCallExpression(call) && ts.isIdentifier(call.expression), 'schema calls a bundled factory');
  return call.expression.text;
}

test('production web and financial contracts bind to fixed Zod 4 and preserve actual compiled parsing', () => {
  const route = compiled.get(join(chunks, 'routes/api/review/approve-bulk.post.mjs'));
  assert.ok(route, 'production bulk approval route exists');
  const body = variable(route, 'BulkApprovalBody');
  const constructor = schemaFactory(body);
  const importStatement = route.statements.filter(ts.isImportDeclaration).find((statement) =>
    statement.importClause?.namedBindings?.elements?.some((item) => item.name.text === constructor));
  assert.ok(importStatement, 'bulk constructor has a local chunk import');
  const imported = importStatement.importClause.namedBindings.elements.find((item) => item.name.text === constructor);
  const vendor = compiled.get(resolve(dirname(route.fileName), importStatement.moduleSpecifier.text));
  assert.ok(vendor, 'bulk constructor resolves within the compiled artifact');
  const exports = vendor.statements.filter(ts.isExportDeclaration).flatMap((statement) => statement.exportClause?.elements ?? []);
  const exported = exports.find((item) => item.name.text === (imported.propertyName ?? imported.name).text);
  assert.ok(exported, 'compiled constructor export exists');
  const object = vendor.statements.find((statement) => ts.isFunctionDeclaration(statement) &&
    statement.name?.text === (exported.propertyName ?? exported.name).text);
  assert.ok(object, 'web object constructor is bundled');
  const returned = object.body.statements.find(ts.isReturnStatement).expression;
  assert.ok(ts.isNewExpression(returned));
  const webClass = variable(vendor, returned.expression.text);
  assert.equal(webClass.initializer.arguments[0].text, 'ZodObject');
  assert.match(webClass.getText(vendor), /\binst\._zod\b/, 'web constructor uses Zod 4 internals');

  const schemaExports = {};
  for (const name of ['financialSnapshotSchema', 'canonicalProtocolSnapshotSchema']) {
    const financial = variable(vendor, name);
    assert.equal(schemaFactory(financial), object.name.text, `${name} uses the same fixed Zod 4 object constructor`);
    const exportedSchema = exports.find((item) => (item.propertyName ?? item.name).text === name);
    assert.ok(exportedSchema, `${name} is exported by the actual production chunk`);
    schemaExports[name] = exportedSchema.name.text;
  }
  const sources = JSON.parse(readFileSync(vendor.fileName + '.map', 'utf8')).sources;
  assert.ok(sources.some((source) => source.includes('/zod@4.6.6/')), 'bundle includes fixed Zod 4');
  assert.ok(!sources.some((source) => /\/zod@3\.|\/zod\/v3\//.test(source)), 'bundle has no legacy Zod runtime');

  // Import the real artifact in a disposable process: Nitro starts a Unix listener and auth DB.
  const directory = mkdtempSync(join(tmpdir(), 'balanceframe-zod-production-'));
  const socket = process.platform === 'win32' ? String.raw`\\.\pipe\balanceframe-zod-${process.pid}-${Date.now()}` : join(directory, 'server.sock');
  try {
    const bindings = importStatement.importClause.namedBindings.elements.map((item) => [item.name.text, (item.propertyName ?? item.name).text]);
    const input = {
      vendor: vendor.fileName, schemaExports, bindings, body: body.initializer.getText(route),
      canonical: JSON.parse(readFileSync(new URL('../../protocol/fixtures/representative.json', import.meta.url), 'utf8')),
      financial: JSON.parse(readFileSync(new URL('../../protocol/fixtures/financial-decision-foundation.json', import.meta.url), 'utf8')).full,
    };
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      import { readFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const input = JSON.parse(readFileSync(0, 'utf8'));
      const artifact = await import(pathToFileURL(input.vendor));
      const canonical = artifact[input.schemaExports.canonicalProtocolSnapshotSchema];
      const financial = artifact[input.schemaExports.financialSnapshotSchema];
      const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
      assert.equal(digest(canonical.parse(input.canonical)), '595fad961c945abed90b623769fa1b40c0d0859af542411672a95253f6c48a56');
      assert.equal(digest(financial.parse(input.financial)), '46ad3264692fe667a36a07d545165d77e0d53c5262a2cc1fe704be7e097fba96');
      const malformed = structuredClone(input.canonical);
      malformed.transactions[0].amount.minorUnits = '9223372036854775808';
      const invalid = canonical.safeParse(malformed);
      assert.equal(invalid.success, false);
      assert.deepEqual(invalid.error.issues[0].path, ['transactions', 0, 'amount', 'minorUnits']);
      const missing = structuredClone(input.financial);
      delete missing.coverage;
      assert.equal(financial.safeParse(missing).success, false);
      assert.equal(financial.safeParse({ ...input.financial, untrusted: true }).success, false);
      const bulk = Function(...input.bindings.map(([local]) => local), 'return ' + input.body)(...input.bindings.map(([, exported]) => artifact[exported]));
      const approved = { ids: ['proposal'], payloadHashes: { proposal: 'a'.repeat(64) } };
      assert.deepEqual(bulk.parse(approved), approved);
      for (const value of [{ ...approved, payloadHashes: { proposal: 'bad' } }, { ...approved, ids: [] }, { ...approved, extra: true }]) assert.equal(bulk.safeParse(value).success, false);
      process.exit(0);
    `], {
      cwd: directory, input: JSON.stringify(input), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
      env: { ...Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LD_LIBRARY_PATH']
        .filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])),
        NODE_ENV: 'production', NITRO_UNIX_SOCKET: socket,
        NUXT_DEV_BYPASS_AUTH: 'false', NUXT_AUTH_DB_PATH: join(directory, 'auth.db'),
        BALANCEFRAME_WORKFLOW_DB_PATH: join(directory, 'workflow.db'),
        BALANCEFRAME_CONFIG_PATH: join(directory, 'connection.json'),
        BALANCEFRAME_EVIDENCE_KEY_PATH: join(directory, 'evidence.key'),
        ACTUAL_SERVER_URL: 'http://127.0.0.1:1', ACTUAL_SECRET_KEY: 'disposable-zod-test',
        ACTUAL_BUDGET_ID: 'disposable-zod-test', ACTUAL_BUDGET_PASSWORD: 'disposable-zod-test',
        ACTUAL_DATA_DIR: join(directory, 'actual'),
        BETTER_AUTH_URL: 'http://127.0.0.1', BETTER_AUTH_SECRET: 'disposable-zod-production-test-secret-0001' },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production external API-key plugin resolves fixed Zod 4 and rejects oversized collections before parsing', async () => {
  const serverRequire = createRequire(join(server, 'package.json'));
  const apiKeyRequire = createRequire(serverRequire.resolve('@better-auth/api-key'));
  const packagePath = apiKeyRequire.resolve('zod/package.json');
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
  assert.equal(metadata.version, '4.6.6');
  // Nitro traces the ESM entry used by the plugin, without the unused CommonJS entry.
  const { z } = await import(pathToFileURL(join(dirname(packagePath), metadata.module)));
  let parsed = 0;
  const item = z.preprocess((value) => { parsed++; return value; }, z.string());
  const result = z.array(item).max(2).safeParse(Array(128).fill(0));
  assert.equal(parsed, 0);
  assert.equal(result.success, false);
  assert.deepEqual(result.error.issues.map((issue) => issue.code), ['too_big']);
});

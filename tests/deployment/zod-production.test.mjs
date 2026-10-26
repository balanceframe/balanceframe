import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

test('production web and financial schemas bind to their own declared Zod major', () => {
  const route = compiled.get(join(chunks, 'routes/api/review/approve-bulk.post.mjs'));
  assert.ok(route, 'production bulk approval route exists');
  const body = variable(route, 'BulkApprovalBody');
  // Follow the actual route constructor import and its chunk export without loading app/auth code.
  const constructor = schemaFactory(body);
  const importStatement = route.statements.filter(ts.isImportDeclaration).find((statement) =>
    statement.importClause?.namedBindings?.elements?.some((item) => item.name.text === constructor));
  assert.ok(importStatement, 'bulk constructor has a local chunk import');
  const imported = importStatement.importClause.namedBindings.elements.find((item) => item.name.text === constructor);
  const vendor = compiled.get(resolve(dirname(route.fileName), importStatement.moduleSpecifier.text));
  assert.ok(vendor, 'bulk constructor resolves within the compiled artifact');
  const exported = vendor.statements.filter(ts.isExportDeclaration).flatMap((statement) => statement.exportClause?.elements ?? [])
    .find((item) => item.name.text === (imported.propertyName ?? imported.name).text);
  assert.ok(exported, 'compiled constructor export exists');
  const object = vendor.statements.find((statement) => ts.isFunctionDeclaration(statement) &&
    statement.name?.text === (exported.propertyName ?? exported.name).text);
  assert.ok(object, 'web object constructor is bundled');
  const returned = object.body.statements.find(ts.isReturnStatement).expression;
  assert.ok(ts.isNewExpression(returned));
  const webClass = variable(vendor, returned.expression.text);
  assert.equal(webClass.initializer.arguments[0].text, 'ZodObject');
  assert.match(webClass.getText(vendor), /\binst\._zod\b/, 'web constructor uses Zod 4 internals');

  for (const name of ['financialSnapshotSchema', 'canonicalProtocolSnapshotSchema']) {
    const financial = variable(vendor, name);
    const factory = variable(vendor, schemaFactory(financial)).initializer;
    assert.equal(factory.name.text, 'create');
    assert.notEqual(factory.expression.text, returned.expression.text, 'financial and web constructors remain distinct');
    const financialClass = variable(vendor, factory.expression.text).initializer;
    assert.ok(ts.isClassExpression(financialClass));
    assert.equal(financialClass.name.text, 'ZodObject');
    assert.ok(financialClass.members.some((member) => member.name?.getText(vendor) === '_parse'), 'financial constructor retains Zod 3 parsing');
  }
  // Nitro emits source lists without mappings, so check versions alongside the concrete bindings.
  const sources = JSON.parse(readFileSync(vendor.fileName + '.map', 'utf8')).sources;
  for (const version of ['3.25.76', '4.6.6']) {
    assert.ok(sources.some((source) => source.includes(`/zod@${version}/`)), `bundle includes Zod ${version}`);
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

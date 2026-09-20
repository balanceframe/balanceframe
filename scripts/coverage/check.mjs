#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const thresholds = {
  'crates/financial-core': 95,
  'crates/core-protocol': 95,
  'crates/node-binding': 90,
  'packages/protocol-generated': 90,
  'tests/contract': 100,
  'tests/actual-integration': 90,
};
const excluded =
  /(^|\/)(?:test|tests|__tests__|fixtures|node_modules|dist|build|generated)(\/|$)|\.(?:test|spec)\.[^/]+$|\.d\.ts$|\/(?:fuzz|phase_85_tests)\.rs$/;
const extensions = /\.(?:[cm]?[jt]sx?|vue|rs)$/;
const slash = (path) => path.split(sep).join('/');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const require = createRequire(import.meta.url);
let typescript;

function walk(root, directory) {
  const absolute = resolve(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.name.startsWith('.') || excluded.test(path.split('/').slice(2).join('/'))) return [];
    return entry.isDirectory() ? walk(root, path) : extensions.test(path) ? [path] : [];
  });
}

function targets(value) {
  if (typeof value === 'string') return [value];
  return value && typeof value === 'object' ? Object.values(value).flatMap(targets) : [];
}

function declaredSources(root, path, metadata, files) {
  const result = new Set();
  for (const target of targets([metadata.main, metadata.module, metadata.bin, metadata.exports])) {
    const local = slash(relative(resolve(root, path), resolve(root, path, target)));
    if (local === '..' || local.startsWith('../'))
      throw new Error(`${path}: entrypoint escapes package: ${target}`);
    if (excluded.test(local) || local.split('/').some((part) => part.startsWith('.'))) continue;
    const pattern = new RegExp(
      `^${local
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    );
    const matches = files.filter((file) => pattern.test(file.slice(path.length + 1)));
    for (const file of matches) result.add(file);
    if (!matches.length && extensions.test(local))
      throw new Error(`${path}: missing declared source entrypoint: ${target}`);
  }
  return result;
}

function hasTests(root, directory) {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).some((entry) => {
    if (
      entry.name.startsWith('.') ||
      ['node_modules', 'dist', 'build', 'generated', 'fixtures'].includes(entry.name)
    )
      return false;
    return entry.isDirectory()
      ? hasTests(root, `${directory}/${entry.name}`)
      : /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name);
  });
}

function requireSuiteConfiguration(pkg) {
  if (pkg.testBearing && !pkg.executable)
    throw new Error(`${pkg.path}: test suite is missing a coverage execution script`);
}

function discover(root) {
  const packages = [];
  for (const group of ['packages', 'apps', 'tests', 'crates']) {
    if (!existsSync(resolve(root, group))) continue;
    for (const entry of readdirSync(resolve(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = `${group}/${entry.name}`;
      const rust = existsSync(resolve(root, path, 'Cargo.toml'));
      const manifest = resolve(root, path, 'package.json');
      if (!rust && !existsSync(manifest)) continue;
      const metadata = existsSync(manifest) ? json(manifest) : {};
      const roots =
        path === 'apps/web'
          ? ['src', 'app', 'server', 'lib', 'composables', 'types']
          : ['src', 'bin'];
      const files = walk(root, path);
      const declared = rust ? new Set() : declaredSources(root, path, metadata, files);
      const sources = files.filter(
        (file) =>
          roots.some((source) => file.startsWith(`${path}/${source}/`)) ||
          declared.has(file) ||
          (path === 'apps/web' && file === 'apps/web/nuxt.config.ts'),
      );
      packages.push({
        path,
        name: metadata.name ?? entry.name,
        rust,
        sources,
        threshold: thresholds[path] ?? 80,
        report: rust
          ? 'rust/coverage.json'
          : `js/${metadata.name?.replace(/^@[^/]+\//, '') ?? entry.name}/lcov.info`,
        executable: Boolean(metadata.scripts?.coverage),
        testBearing:
          !rust &&
          (Boolean(metadata.scripts?.test || metadata.scripts?.coverage) ||
            ['tests/contract', 'tests/actual-integration'].includes(path) ||
            hasTests(root, path)),
      });
    }
  }
  if (existsSync(resolve(root, 'scripts/coverage/check.mjs'))) {
    packages.push({
      path: 'scripts/coverage',
      name: 'coverage-gates',
      rust: false,
      sources: walk(root, 'scripts/coverage'),
      threshold: 80,
      report: 'js/coverage-gates/lcov.info',
      executable: false,
    });
  }
  return packages.sort((a, b) => a.path.localeCompare(b.path));
}

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function changedFiles(root, base) {
  const mergeBase = git(root, 'merge-base', 'HEAD', base);
  const split = (value) => value.split('\0').filter(Boolean);
  return new Set([
    ...split(git(root, 'diff', '--name-only', '-z', '--diff-filter=ACMRT', mergeBase)),
    ...split(git(root, 'ls-files', '--others', '--exclude-standard', '-z')),
  ]);
}

function parseLcov(text, root, packagePath) {
  const files = new Map();
  let record;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (raw.startsWith('SF:')) {
      if (record) throw new Error('Unterminated LCOV record');
      const source = raw.slice(3);
      if (!source) throw new Error('Empty LCOV source');
      // Vitest emits paths relative to the package; Node may emit absolute paths.
      const path = slash(
        relative(
          root,
          isAbsolute(source)
            ? source
            : existsSync(resolve(root, source))
              ? resolve(root, source)
              : resolve(root, packagePath, source),
        ),
      );
      record = { path, lines: new Map(), total: undefined, covered: undefined };
    } else if (/^(DA|LF|LH):/.test(raw)) {
      if (!record) throw new Error('LCOV counts without a source');
      if (raw.startsWith('DA:')) {
        const match = /^DA:([1-9]\d*),(\d+)(?:,[^,]+)?$/.exec(raw);
        if (
          !match ||
          !Number.isSafeInteger(Number(match[1])) ||
          !Number.isSafeInteger(Number(match[2]))
        )
          throw new Error('Invalid LCOV line count');
        const line = Number(match[1]);
        if (record.lines.has(line)) throw new Error('Duplicate LCOV line');
        record.lines.set(line, Number(match[2]) > 0);
      } else {
        const match = /^(LF|LH):(\d+)$/.exec(raw);
        if (!match || !Number.isSafeInteger(Number(match[2])))
          throw new Error('Invalid LCOV summary');
        const field = match[1] === 'LF' ? 'total' : 'covered';
        if (record[field] !== undefined) throw new Error('Duplicate LCOV summary');
        record[field] = Number(match[2]);
      }
    } else if (raw === 'end_of_record') {
      if (
        !record ||
        record.total !== record.lines.size ||
        record.covered !== [...record.lines.values()].filter(Boolean).length
      )
        throw new Error('Inconsistent LCOV line totals');
      if (files.has(record.path)) throw new Error(`Duplicate LCOV source: ${record.path}`);
      files.set(record.path, { total: record.total, covered: record.covered });
      record = undefined;
    } else if (!/^(?:TN|FN|FNDA|FNF|FNH|BRDA|BRF|BRH|VER):/.test(raw)) {
      throw new Error(`Unrecognized LCOV record: ${raw}`);
    }
  }
  if (record) throw new Error('Unterminated LCOV record');
  return files;
}

function parseLlvm(report, root) {
  if (
    report?.type !== 'llvm.coverage.json.export' ||
    !/^3\.\d+\.\d+$/.test(report.version ?? '') ||
    !/^\d+\.\d+\.\d+/.test(report.cargo_llvm_cov?.version ?? '') ||
    report.cargo_llvm_cov?.manifest_path !== resolve(root, 'Cargo.toml') ||
    !Array.isArray(report.data) ||
    report.data.length !== 1 ||
    !Array.isArray(report.data[0]?.files)
  ) {
    throw new Error('Invalid LLVM coverage producer or export schema');
  }
  const files = new Map();
  for (const file of report.data[0].files) {
    if (
      typeof file?.filename !== 'string' ||
      !isAbsolute(file.filename) ||
      file.filename.includes('\0')
    ) {
      throw new Error('Invalid LLVM source filename');
    }
    const lines = file.summary?.lines;
    if (
      !Number.isSafeInteger(lines?.count) ||
      !Number.isSafeInteger(lines?.covered) ||
      lines.count < 0 ||
      lines.covered < 0 ||
      lines.covered > lines.count ||
      !Number.isFinite(lines.percent) ||
      lines.percent < 0 ||
      lines.percent > 100
    ) {
      throw new Error(`Invalid LLVM line summary: ${file.filename}`);
    }
    const path = slash(relative(root, file.filename));
    if (files.has(path)) throw new Error(`Duplicate LLVM source: ${path}`);
    files.set(path, { total: lines.count, covered: lines.covered });
  }
  return files;
}

function nonExecutableSource(root, path, rust) {
  if (!rust && !/\.(?:[cm]?ts|tsx)$/.test(path)) return false;
  const source = readFileSync(resolve(root, path), 'utf8');
  if (rust) {
    // Deliberately conservative: scan comments and strings too. Only attribute
    // and module-doc markers are exempt from the macro-invocation bang check.
    return !/\b(?:fn|impl|const|static)\b|(?<!#)(?<!\/\/)(?<!\/\*)!/.test(source);
  }
  typescript ??= require('typescript');
  const ast = typescript.createSourceFile(
    path,
    source,
    typescript.ScriptTarget.Latest,
    false,
    path.endsWith('.tsx') ? typescript.ScriptKind.TSX : typescript.ScriptKind.TS,
  );
  if (ast.parseDiagnostics.length) return false;
  return ast.statements.every(
    (statement) =>
      typescript.isInterfaceDeclaration(statement) ||
      typescript.isTypeAliasDeclaration(statement) ||
      (typescript.isImportDeclaration(statement) && statement.importClause?.isTypeOnly === true) ||
      (typescript.isExportDeclaration(statement) && statement.isTypeOnly === true),
  );
}
const metric = (covered, total) => ({
  covered,
  total,
  line: total === 0 ? null : (100 * covered) / total,
});

function check({ root, reports, base = 'HEAD', requireExecution = false }) {
  const changed = changedFiles(root, base);
  const packages = discover(root);
  if (!packages.length) throw new Error('No workspace packages discovered');
  const summary = { base, packages: {}, workspace: metric(0, 0), failures: [] };
  let rustRecords, rustError;
  if (packages.some((pkg) => pkg.rust)) {
    try {
      rustRecords = parseLlvm(json(resolve(reports, 'rust/coverage.json')), root);
    } catch (error) {
      rustError = error;
    }
  }
  for (const pkg of packages) {
    let records = new Map();
    let reportAvailable = false;
    try {
      requireSuiteConfiguration(pkg);
      // Source-free test suites still have a real, possibly empty, provider report.
      if (pkg.rust) {
        if (rustError) throw rustError;
        records = rustRecords;
      } else if (pkg.sources.length || pkg.executable) {
        records = parseLcov(readFileSync(resolve(reports, pkg.report), 'utf8'), root, pkg.path);
      }
      reportAvailable = true;
      if (pkg.path === 'apps/cli' && pkg.sources.some((path) => path.startsWith('apps/cli/bin/'))) {
        const entrypoints = parseLcov(
          readFileSync(resolve(reports, 'js/cli/entrypoint-lcov.info'), 'utf8'),
          root,
          pkg.path,
        );
        for (const path of pkg.sources.filter((path) => path.startsWith('apps/cli/bin/'))) {
          records.delete(path);
          if (entrypoints.has(path)) records.set(path, entrypoints.get(path));
        }
      }
      if (requireExecution && pkg.path === 'crates/node-binding') {
        const loads = readFileSync(resolve(reports, 'native/loads.log'), 'utf8');
        if (!/^(?:[1-9]\d*\n)+$/.test(loads))
          throw new Error('Missing or malformed native Node loading evidence');
      }
      if (requireExecution && pkg.executable) {
        const evidence = json(resolve(reports, dirname(pkg.report), 'tests.json'));
        if (
          evidence.success !== true ||
          !Number.isSafeInteger(evidence.numTotalTests) ||
          evidence.numTotalTests < 1 ||
          evidence.numPassedTests !== evidence.numTotalTests ||
          evidence.numPendingTests !== 0 ||
          evidence.numFailedTests !== 0 ||
          (evidence.numTodoTests ?? 0) !== 0
        )
          throw new Error('Tests missing, failed, skipped or pending');
      }
    } catch (error) {
      summary.failures.push(`${pkg.path}: ${error.message}`);
    }
    let covered = 0,
      total = 0,
      changedCovered = 0,
      changedTotal = 0;
    const nonExecutableSources = [];
    for (const path of pkg.sources) {
      const count = records.get(path);
      if (!count) {
        if (reportAvailable && nonExecutableSource(root, path, pkg.rust)) {
          nonExecutableSources.push(path);
          continue;
        }
        summary.failures.push(`${pkg.path}: missing source coverage: ${path}`);
        continue;
      }
      covered += count.covered;
      total += count.total;
      if (changed.has(path)) {
        changedCovered += count.covered;
        changedTotal += count.total;
      }
    }
    const entry = {
      ...metric(covered, total),
      threshold: pkg.threshold,
      sourceFiles: pkg.sources.length,
      changed: metric(changedCovered, changedTotal),
      nonExecutableSources,
      report: pkg.sources.length || pkg.executable ? pkg.report : null,
    };
    summary.packages[pkg.path] = entry;
    if (entry.line !== null && entry.line < pkg.threshold)
      summary.failures.push(`${pkg.path}: ${entry.line.toFixed(2)}% < ${pkg.threshold}%`);
    if (entry.changed.line !== null && entry.changed.line < pkg.threshold)
      summary.failures.push(
        `${pkg.path} changed files: ${entry.changed.line.toFixed(2)}% < ${pkg.threshold}%`,
      );
    summary.workspace.covered += covered;
    summary.workspace.total += total;
  }
  summary.workspace = metric(summary.workspace.covered, summary.workspace.total);
  if (summary.workspace.line === null || summary.workspace.line < 80)
    summary.failures.push('Workspace line coverage below 80% or empty');
  mkdirSync(reports, { recursive: true });
  writeFileSync(resolve(reports, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

function main(args) {
  let root = resolve(fileURLToPath(new URL('../..', import.meta.url))),
    reports,
    base = 'HEAD',
    requireExecution = false,
    list = false,
    sourcePackage;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--require-execution') requireExecution = true;
    else if (arg === '--list') list = true;
    else if (['--root', '--reports', '--base', '--sources'].includes(arg) && args[i + 1]) {
      const value = args[++i];
      if (arg === '--root') root = resolve(value);
      else if (arg === '--reports') reports = value;
      else if (arg === '--sources') sourcePackage = value;
      else base = value;
    } else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  if (list || sourcePackage) {
    const packages = discover(root);
    for (const pkg of packages) requireSuiteConfiguration(pkg);
    if (sourcePackage) {
      const pkg = packages.find((item) => item.name === sourcePackage);
      if (!pkg) throw new Error(`Unknown source package: ${sourcePackage}`);
      for (const file of pkg.sources)
        console.log(file.slice(pkg.path.length + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    } else {
      for (const pkg of packages)
        if (pkg.executable && !pkg.rust) console.log(`${pkg.name}\t${dirname(pkg.report)}`);
    }
    return;
  }
  const summary = check({
    root,
    reports: resolve(root, reports ?? 'coverage'),
    base,
    requireExecution,
  });
  for (const [path, value] of Object.entries(summary.packages)) {
    console.log(
      `${path}: ${value.line === null ? 'N/A (no executable production lines)' : `${value.line.toFixed(2)}%`} / ${value.threshold}% (${value.covered}/${value.total}); changed ${value.changed.line?.toFixed(2) ?? 'N/A'}%`,
    );
  }
  console.log(
    `Workspace: ${summary.workspace.line?.toFixed(2) ?? 'N/A'}% (${summary.workspace.covered}/${summary.workspace.total})`,
  );
  if (summary.failures.length) {
    console.error(summary.failures.join('\n'));
    process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

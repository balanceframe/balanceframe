import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { after, describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const canonical = resolve(root, 'compose.yaml');
const actualOverlay = resolve(root, 'compose.actual.yaml');
const researchOverlay = resolve(root, 'compose.research.yaml');
const validator = resolve(root, 'tests/deployment/compose-validate.sh');
const fixedContainerPath = '/run/secrets/merchant-research.json';
const cleanup = [];
let sequence = 0;

after(() => {
  for (const path of cleanup) rmSync(path, { recursive: true, force: true });
});

function scratch() {
  const path = mkdtempSync(join(tmpdir(), 'balanceframe-compose-research-'));
  cleanup.push(path);
  return path;
}

function renderer() {
  if (process.env.COMPOSE_BIN) return { command: process.env.COMPOSE_BIN, prefix: [] };
  return { command: 'docker', prefix: ['compose'] };
}

function sentinelEnvironment(sourcePath) {
  return {
    BALANCEFRAME_IMAGE_REF: 'balanceframe:compose-sentinel',
    BALANCEFRAME_PORT: '3030',
    ACTUAL_SERVER_URL: 'http://actual.example.invalid',
    ACTUAL_SECRET_KEY: 'actual-secret-sentinel-private',
    BETTER_AUTH_SECRET: 'auth-secret-sentinel-private',
    BETTER_AUTH_URL: 'http://localhost:3030',
    ...(sourcePath ? { BALANCEFRAME_MERCHANT_CONFIG_FILE: sourcePath } : {}),
    ...(sourcePath ? { VALUESERP_API_KEY: 'provider-key-sentinel-private' } : {}),
  };
}

function writeEnvFile(directory, values) {
  const path = join(directory, `compose-${++sequence}.env`);
  writeFileSync(path, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
  return path;
}

function invokeCompose(files, values) {
  const directory = scratch();
  const envFile = writeEnvFile(directory, values);
  const invocation = renderer();
  return spawnSync(invocation.command, [
    ...invocation.prefix,
    '--env-file', envFile,
    '--project-directory', directory,
    '--project-name', `balanceframe-compose-test-${sequence}`,
    ...files.flatMap((file) => ['-f', file]),
    'config', '--format', 'json',
  ], {
    cwd: directory,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: directory,
      TMPDIR: directory,
      XDG_CONFIG_HOME: join(directory, 'xdg'),
      DOCKER_CONFIG: join(directory, 'docker'),
    },
    encoding: 'utf8',
  });
}

function parseConfig(result) {
  assert.equal(result.status, 0, 'Compose renders the explicit manifest set');
  try {
    return JSON.parse(result.stdout);
  } catch {
    assert.fail('Compose emits JSON config');
  }
}

function serviceEnvironment(service) {
  if (Array.isArray(service.environment)) {
    return Object.fromEntries(service.environment.map((entry) => {
      const separator = entry.indexOf('=');
      return separator < 0 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
  }
  return service.environment ?? {};
}

function stagedProject() {
  const directory = scratch();
  copyFileSync(canonical, join(directory, 'compose.yaml'));
  copyFileSync(actualOverlay, join(directory, 'compose.actual.yaml'));
  if (existsSync(researchOverlay)) copyFileSync(researchOverlay, join(directory, 'compose.research.yaml'));
  writeFileSync(join(directory, '.env'), [
    'BALANCEFRAME_IMAGE_REF=',
    'ACTUAL_SECRET_KEY=',
    'BETTER_AUTH_SECRET=',
    'BETTER_AUTH_URL=',
    'VALUESERP_API_KEY=dotenv-provider-secret-sentinel-private',
    `BALANCEFRAME_MERCHANT_CONFIG_FILE=${join(directory, 'dotenv-source-sentinel')}`,
  ].join('\n'));
  const poisonCompose = join(directory, 'ambient-compose.yaml');
  writeFileSync(poisonCompose, 'this is not a Compose document\n');
  return { directory, poisonCompose };
}

function runValidator(overlayPath = researchOverlay, { canonicalPath, inheritedTmpdir, composeBin } = {}) {
  const { directory, poisonCompose } = stagedProject();
  const files = [
    join(directory, 'compose.yaml'),
    join(directory, 'compose.actual.yaml'),
    overlayPath === researchOverlay ? join(directory, 'compose.research.yaml') : overlayPath,
  ];
  const compose = renderer();
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: directory,
    TMPDIR: inheritedTmpdir ?? directory,
    COMPOSE_FILE: poisonCompose,
    BALANCEFRAME_IMAGE_REF: '',
    ACTUAL_SECRET_KEY: '',
    BETTER_AUTH_SECRET: '',
    BETTER_AUTH_URL: '',
    VALUESERP_API_KEY: 'caller-provider-secret-sentinel-private',
    BALANCEFRAME_MERCHANT_CONFIG_FILE: join(directory, 'caller-source-sentinel'),
  };
  if (composeBin || process.env.COMPOSE_BIN || compose.command !== 'docker') env.COMPOSE_BIN = composeBin ?? compose.command;
  return spawnSync('bash', [validator, canonicalPath ?? files[0], files[1], files[2]], {
    cwd: directory,
    env,
    encoding: 'utf8',
  });
}

function policyElidingRenderer({ elideRaw = false } = {}) {
  const path = join(scratch(), 'compose-policy-eliding.mjs');
  const { command, prefix } = renderer();
  writeFileSync(path, `#!${process.execPath}
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(command)}, [...${JSON.stringify(prefix)}, ...args], { encoding: 'utf8' });
if (result.status !== 0) process.exit(1);
const config = JSON.parse(result.stdout);
// Model typed serialization dropping policy fields; the raw model retains them.
if (${JSON.stringify(elideRaw)} || !args.includes('--no-interpolate')) {
  for (const service of Object.values(config.services ?? {})) {
    for (const mount of service.volumes ?? []) {
      if (mount.bind) delete mount.bind.create_host_path;
    }
  }
}
process.stdout.write(JSON.stringify(config));
`, { mode: 0o700 });
  return path;
}

function assertSafeValidatorOutput(result, extraForbidden = []) {
  const output = `${result.stdout}\n${result.stderr}`;
  const forbidden = [
    'actual-secret-sentinel-private',
    'auth-secret-sentinel-private',
    'provider-key-sentinel-private',
    'caller-provider-secret-sentinel-private',
    'dotenv-provider-secret-sentinel-private',
    'caller-source-sentinel',
    'dotenv-source-sentinel',
    ...extraForbidden,
  ];
  assert.equal(forbidden.some((value) => output.includes(value)), false, 'validator output excludes sentinel secrets and paths');
  assert.equal(/"services"\s*:\s*\{|^services:\s*$/m.test(output), false, 'validator output excludes rendered Compose JSON/YAML');
  assert.equal(/"environment"\s*:\s*\{|^\s+environment:\s*$/m.test(output), false, 'validator output excludes rendered environment configuration');
}

function assertValidatorSetupFailure(result, pathSentinel) {
  assert.notEqual(result.status, 0, 'invalid validator setup is rejected');
  assert.match(result.stdout, /^FAIL: [A-Za-z ]{1,64}\n$/u, 'failure uses one bounded fixed-format diagnostic');
  assert.equal(result.stdout.split('\n').length, 2, 'failure emits only one diagnostic line');
  assert.equal(result.stderr, '', 'setup diagnostics are suppressed');
  assertSafeValidatorOutput(result, [pathSentinel]);
}


describe('optional merchant research Compose overlay', () => {
  it('leaves the canonical service local-only unless the overlay is explicitly selected', () => {
    const config = parseConfig(invokeCompose([canonical], sentinelEnvironment()));
    assert.deepEqual(Object.keys(config.services).sort(), ['balanceframe']);
    const service = config.services.balanceframe;
    const environment = serviceEnvironment(service);
    assert.equal(environment.VALUESERP_API_KEY, undefined);
    assert.equal(environment.BALANCEFRAME_MERCHANT_CONFIG_PATH, undefined);
    assert.equal(service.volumes.some((mount) => mount.target === fixedContainerPath), false);
    assert.equal(service.volumes.filter((mount) => mount.target === '/data').length, 1);
  });

  it('requires both operator-owned config source and provider key only when opted in', () => {
    const source = join(scratch(), 'operator-config', 'merchant.json');
    const withBoth = parseConfig(invokeCompose([canonical, researchOverlay], sentinelEnvironment(source)));
    const environment = serviceEnvironment(withBoth.services.balanceframe);
    assert.equal(environment.BALANCEFRAME_MERCHANT_CONFIG_PATH, fixedContainerPath);
    assert.equal(environment.VALUESERP_API_KEY === 'provider-key-sentinel-private', true, 'provider key is rendered only in the explicit overlay');

    assert.notEqual(
      invokeCompose([canonical, researchOverlay], sentinelEnvironment()).status,
      0,
      'research overlay rejects missing source and key',
    );
    const missingKey = { ...sentinelEnvironment(source) };
    delete missingKey.VALUESERP_API_KEY;
    assert.notEqual(
      invokeCompose([canonical, researchOverlay], missingKey).status,
      0,
      'research overlay rejects missing provider key',
    );
    const missingSource = { ...sentinelEnvironment(source) };
    delete missingSource.BALANCEFRAME_MERCHANT_CONFIG_FILE;
    assert.notEqual(
      invokeCompose([canonical, researchOverlay], missingSource).status,
      0,
      'research overlay rejects missing config source',
    );
  });

  it('renders one exact read-only file bind without creating a missing source directory', () => {
    const directory = scratch();
    const source = join(directory, 'must-not-be-created', 'merchant.json');
    const config = parseConfig(invokeCompose([canonical, researchOverlay], sentinelEnvironment(source)));
    const mounts = config.services.balanceframe.volumes.filter((mount) => mount.target === fixedContainerPath);
    assert.equal(mounts.length, 1, 'the fixed server path has exactly one mount');
    assert.equal(mounts[0].type, 'bind');
    assert.equal(mounts[0].source, source);
    assert.equal(mounts[0].target, fixedContainerPath);
    assert.equal(mounts[0].read_only, true);
    assert.ok(mounts[0].bind, 'the explicit bind policy survives rendering');
    assert.ok(mounts[0].bind.create_host_path === false ||
      !Object.hasOwn(mounts[0].bind, 'create_host_path'),
    'the bind disables host-path creation, including renderers that omit false');
    assert.equal(existsSync(dirname(source)), false, 'Compose config rendering does not create the absent host source directory');
  });

  it('validates with isolated Compose inputs despite hostile ambient .env and COMPOSE_FILE', () => {
    const result = runValidator();
    assert.equal(result.status, 0, 'offline validator succeeds with explicit renderer and its private sentinels');
    assertSafeValidatorOutput(result);
  });

  it('accepts a safe bind when the renderer omits its explicit false field', () => {
    const source = join(scratch(), 'missing', 'merchant.json');
    const config = parseConfig(invokeCompose([canonical, researchOverlay], sentinelEnvironment(source)));
    const mount = config.services.balanceframe.volumes.find((mount) => mount.target === fixedContainerPath);
    assert.ok(mount.bind && typeof mount.bind === 'object', 'the explicit bind policy survives rendering');
    assert.notEqual(mount.bind.create_host_path, true, 'the renderer never enables host-path creation');
    assert.match(readFileSync(researchOverlay, 'utf8'), /^\s+create_host_path: false\s*$/m,
      'the source overlay explicitly disables host-path creation');
    const result = runValidator();
    assert.equal(result.status, 0, 'safe rendering is accepted with explicit false or its omitted representation');
    assertSafeValidatorOutput(result);
  });

  for (const policy of ['true', 'omitted', 'missing-field', 'short']) {
    it(`rejects the research bind with ${policy} host-path creation policy`, () => {
      const overlay = join(scratch(), 'unsafe-research.yaml');
      const original = readFileSync(researchOverlay, 'utf8');
      assert.match(original, /^\s+create_host_path: false\s*$/m, 'the control mutates the explicit safe policy');
      let mutated;
      if (policy === 'short') {
        mutated = original.replace(/    volumes:[\s\S]*$/u,
          '    volumes:\n      - ${BALANCEFRAME_MERCHANT_CONFIG_FILE:?required}:/run/secrets/merchant-research.json:ro\n');
      } else if (policy === 'missing-field') {
        mutated = original.replace('          create_host_path: false\n', '');
      } else {
        mutated = original.replace('        bind:\n          create_host_path: false\n',
          policy === 'true' ? '        bind:\n          create_host_path: true\n' : '');
      }
      assert.notEqual(mutated, original, 'the unsafe control changes the source overlay');
      writeFileSync(overlay, mutated);
      const result = runValidator(overlay);
      assert.notEqual(result.status, 0, 'the validator rejects the unsafe or unspecified policy');
      assertSafeValidatorOutput(result);
    });
  }

  it('validates safe source policy when normalized JSON elides the policy field', () => {
    const result = runValidator(researchOverlay, { composeBin: policyElidingRenderer() });
    assert.equal(result.status, 0, 'the raw source policy proves the safe normalized representation');
    assertSafeValidatorOutput(result);
  });

  it('rejects a renderer that cannot preserve the raw source policy', () => {
    const result = runValidator(researchOverlay, { composeBin: policyElidingRenderer({ elideRaw: true }) });
    assert.notEqual(result.status, 0, 'missing raw evidence must fail closed even for safe source YAML');
    assertSafeValidatorOutput(result);
  });

  for (const policy of ['true', 'short', 'decoy-false']) {
    it(`rejects ${policy} source policy when normalized JSON elides the policy field`, () => {
      const overlay = join(scratch(), 'unsafe-elided-policy.yaml');
      const original = readFileSync(researchOverlay, 'utf8');
      const mutated = policy === 'short'
        ? original.replace(/    volumes:[\s\S]*$/u,
          '    volumes:\n      - ${BALANCEFRAME_MERCHANT_CONFIG_FILE:?required}:/run/secrets/merchant-research.json:ro\n')
        : original.replace('create_host_path: false', 'create_host_path: true') +
          (policy === 'decoy-false' ? '\nx-unrelated-policy:\n  create_host_path: false\n' : '');
      assert.notEqual(mutated, original, 'the fixture changes the actual research mount policy');
      writeFileSync(overlay, mutated);
      const result = runValidator(overlay, { composeBin: policyElidingRenderer() });
      assert.notEqual(result.status, 0, 'the source mount policy must reject unsafe normalized output');
      assertSafeValidatorOutput(result);
    });
  }

  for (const syntax of ['long', 'short']) {
    it(`rejects an extra ${syntax} mount whose interpolated target collides with the safe research bind`, () => {
      const overlay = join(scratch(), 'colliding-research-target.yaml');
      const original = readFileSync(researchOverlay, 'utf8');
      const extraMount = syntax === 'long'
        ? [
          '      - type: bind',
          '        source: ${BALANCEFRAME_MERCHANT_CONFIG_FILE:?required}',
          '        target: ${COLLIDING_TARGET:-/run/secrets/merchant-research.json}',
          '        read_only: true',
          '        bind:',
          '          create_host_path: true',
        ]
        : ['      - ${BALANCEFRAME_MERCHANT_CONFIG_FILE:?required}:${COLLIDING_TARGET:-/run/secrets/merchant-research.json}:ro'];
      writeFileSync(overlay, `${original}${extraMount.join('\n')}\n`);
      const result = runValidator(overlay, { composeBin: policyElidingRenderer() });
      assert.notEqual(result.status, 0, 'an extra source mount cannot replace the proven safe bind after interpolation');
      assertSafeValidatorOutput(result);
    });
  }
  it('suppresses diagnostics for a missing canonical project parent', () => {
    const directory = scratch();
    const pathSentinel = 'canonical-parent-path-sentinel-private';
    const canonicalPath = join(directory, pathSentinel, 'compose.yaml');
    const result = runValidator(researchOverlay, { canonicalPath });
    assertValidatorSetupFailure(result, pathSentinel);
  });

  it('suppresses diagnostics when inherited TMPDIR is invalid', () => {
    const directory = scratch();
    const pathSentinel = 'invalid-tmpdir-sentinel-private';
    const inheritedTmpdir = join(directory, pathSentinel);
    const result = runValidator(researchOverlay, { inheritedTmpdir });
    assertValidatorSetupFailure(result, pathSentinel);
  });

  it('keeps failure diagnostics free of key values and rendered configuration', () => {
    const result = runValidator(join(scratch(), 'missing-research-overlay.yaml'));
    assert.notEqual(result.status, 0, 'missing overlay is rejected');
    assertSafeValidatorOutput(result);
  });
});

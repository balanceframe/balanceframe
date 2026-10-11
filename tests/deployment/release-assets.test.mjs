import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { after, describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const tag = 'v1.2.3';
const digest = `sha256:${'a'.repeat(64)}`;
const image = `ghcr.io/release-test/balanceframe@${digest}`;
const repository = mkdtempSync(join(tmpdir(), 'balanceframe-release-assets-'));
chmodSync(repository, 0o700);
const release = join(repository, '_release', tag);
let composeProject = 0;

after(() => rmSync(repository, { recursive: true, force: true }));

function privateEnvironment(directory, extra = {}) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: directory,
    TMPDIR: directory,
    XDG_CONFIG_HOME: join(directory, 'xdg'),
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: repository,
    env: privateEnvironment(repository),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `git ${args[0]} succeeds`);
  return result.stdout.trim();
}

function runReleaseAssets(inputTag, inputDigest) {
  return spawnSync('bash', [resolve(root, 'scripts/release-assets.sh'), inputTag, inputDigest], {
    cwd: repository,
    env: privateEnvironment(repository),
    encoding: 'utf8',
  });
}

function stageRepository() {
  git(['init', '--quiet']);
  git(['remote', 'add', 'origin', 'https://github.com/release-test/balanceframe.git']);
  for (const file of ['compose.yaml', 'compose.actual.yaml', 'compose.research.yaml', '.env.example']) {
    copyFileSync(resolve(root, file), join(repository, file));
  }
  assert.equal(git(['remote', 'get-url', 'origin']), 'https://github.com/release-test/balanceframe.git');
  assert.equal(git(['rev-list', '--all', '--count']), '0', 'fixture repository has no commits');

  const result = runReleaseAssets(tag, digest);
  assert.equal(result.status, 0, 'the real release asset script completes without publishing');
  assert.equal(git(['rev-list', '--all', '--count']), '0', 'asset generation does not create a commit');
}

stageRepository();

function parseChecksumFile(contents) {
  const entries = contents.trimEnd().split('\n').map((line) => {
    const match = /^([a-f0-9]{64})  ([^/]+)$/u.exec(line);
    assert.ok(match, 'checksum entries use sha256sum format and a basename');
    return [match[2], match[1]];
  });
  return new Map(entries);
}

function composeEnvironment({ providerInputs = true } = {}) {
  const env = privateEnvironment(release, {
    ACTUAL_SECRET_KEY: 'fixture-actual-key',
    ACTUAL_SERVER_URL: 'https://actual.example.invalid',
    BALANCEFRAME_IMAGE_REF: 'ambient-image-must-not-win',
    BALANCEFRAME_PORT: '3131',
    BETTER_AUTH_SECRET: 'fixture-auth-secret',
    BETTER_AUTH_URL: 'https://balanceframe.example.invalid',
  });
  if (providerInputs) {
    env.BALANCEFRAME_MERCHANT_CONFIG_FILE = join(repository, 'operator', 'merchant.json');
    env.VALUESERP_API_KEY = 'fixture-provider-key';
  }
  return env;
}

function render(files, options) {
  const command = process.env.COMPOSE_BIN || 'docker';
  const prefix = process.env.COMPOSE_BIN ? [] : ['compose'];
  return spawnSync(command, [
    ...prefix,
    '--project-directory', release,
    '--project-name', `balanceframe-release-assets-${++composeProject}`,
    ...files.flatMap((file) => ['-f', join(release, file)]),
    'config', '--format', 'json',
  ], {
    cwd: release,
    env: composeEnvironment(options),
    encoding: 'utf8',
  });
}

function config(result) {
  assert.equal(result.status, 0, 'the actual Compose renderer accepts the released manifests');
  try {
    return JSON.parse(result.stdout);
  } catch {
    assert.fail('Compose emits JSON configuration');
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

function parseEnvExample(contents) {
  return Object.fromEntries(contents.split(/\r?\n/u).flatMap((line) => {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/u.exec(line);
    return match ? [[match[1], match[2]]] : [];
  }));
}

describe('generated release deployment assets', () => {
  it('includes the opt-in research overlay and checksums for each delivered asset', () => {
    const assets = ['compose.yaml', 'compose.actual.yaml', 'compose.research.yaml', '.env.example'];
    for (const file of [...assets, 'CHECKSUMS']) {
      assert.equal(existsSync(join(release, file)), true, `${file} is generated`);
    }

    const checksums = parseChecksumFile(readFileSync(join(release, 'CHECKSUMS'), 'utf8'));
    assert.deepEqual([...checksums.keys()].sort(), [...assets].sort());
    for (const file of assets) {
      const bytes = readFileSync(join(release, file));
      const actual = createHash('sha256').update(bytes).digest('hex');
      assert.equal(checksums.get(file), actual, `${file} CHECKSUMS entry validates its bytes`);

      const individual = parseChecksumFile(readFileSync(join(release, `${file}.sha256`), 'utf8'));
      assert.deepEqual([...individual], [[file, actual]], `${file}.sha256 validates the same bytes`);
    }

    const env = parseEnvExample(readFileSync(join(release, '.env.example'), 'utf8'));
    assert.equal(env.BETTER_AUTH_SECRET, '', 'auth secret remains unset in the operator template');
    assert.equal(env.ACTUAL_SECRET_KEY, '', 'Actual key remains unset in the operator template');
    assert.equal(env.VALUESERP_API_KEY, undefined, 'provider credentials stay inert by default');
  });

  it('renders current canonical, bundled Actual, and explicit research behavior', () => {
    const canonical = config(render(['compose.yaml'], { providerInputs: true }));
    const service = canonical.services.balanceframe;
    assert.equal(service.image, image, 'release image is pinned to the supplied immutable digest');
    const environment = serviceEnvironment(service);
    assert.equal(environment.NUXT_AUTH_DB_PATH, '/data/auth.db');
    assert.equal(environment.BALANCEFRAME_CONFIG_PATH, '/data/config.json');
    assert.equal(Object.hasOwn(environment, 'ACTUAL_SERVER_URL'), true);
    assert.equal(environment.ACTUAL_SECRET_KEY, 'fixture-actual-key');
    assert.equal(environment.BALANCEFRAME_WORKFLOW_DB_PATH, '/data/workflow.db');
    assert.equal(environment.BETTER_AUTH_SECRET, 'fixture-auth-secret');
    assert.equal(Object.hasOwn(environment, 'BETTER_AUTH_URL'), true);
    assert.equal(environment.BALANCEFRAME_BOOTSTRAP_SECRET_FILE, '/run/secrets/bootstrap_secret');
    assert.equal(environment.BALANCEFRAME_MERCHANT_CONFIG_PATH, undefined);
    assert.equal(environment.VALUESERP_API_KEY, undefined, 'canonical deployment does not enable research');
    assert.equal(service.volumes.some((volume) => volume.target === '/run/secrets/merchant-research.json'), false);
    assert.equal(service.volumes.some((volume) => volume.target === '/data' && volume.source === 'balanceframe-data'), true);
    assert.equal(canonical.networks.default.external, true);
    assert.equal(canonical.networks.default.name, 'balanceframe-net');
    assert.equal(canonical.secrets.bootstrap_secret.file, join(release, '.bootstrap_secret'));

    const bundled = config(render(['compose.yaml', 'compose.actual.yaml']));
    assert.deepEqual(Object.keys(bundled.services).sort(), ['actual', 'balanceframe']);
    assert.notEqual(bundled.networks.default.external, true, 'bundled Actual uses a managed shared network');
    assert.equal(bundled.networks.default.name, 'balanceframe');
    assert.equal(bundled.services.actual.volumes.some((volume) => volume.target === '/data' && volume.source === 'actual-data'), true);

    const research = config(render(['compose.yaml', 'compose.research.yaml']));
    const researchService = research.services.balanceframe;
    const researchEnvironment = serviceEnvironment(researchService);
    assert.equal(researchEnvironment.BALANCEFRAME_MERCHANT_CONFIG_PATH, '/run/secrets/merchant-research.json');
    assert.equal(researchEnvironment.VALUESERP_API_KEY, 'fixture-provider-key');
    const mount = researchService.volumes.find((volume) => volume.target === '/run/secrets/merchant-research.json');
    assert.equal(mount.type, 'bind');
    assert.equal(mount.source, join(repository, 'operator', 'merchant.json'));
    assert.equal(mount.read_only, true);
    assert.equal(mount.bind?.create_host_path, false);

    const missingInputs = render(['compose.yaml', 'compose.research.yaml'], { providerInputs: false });
    assert.notEqual(missingInputs.status, 0, 'research remains opt-in and requires its operator inputs');
  });
  it('rejects unsafe tags and digests and does not overwrite an existing release', () => {
    const escapedPath = join(repository, 'escaped');
    assert.notEqual(runReleaseAssets('../escaped', digest).status, 0);
    assert.equal(existsSync(escapedPath), false, 'a traversal tag cannot write outside _release');

    assert.notEqual(runReleaseAssets('v1.2.4', 'sha256:invalid').status, 0);
    assert.equal(existsSync(join(repository, '_release', 'v1.2.4')), false);

    const original = readFileSync(join(release, 'compose.yaml'));
    assert.notEqual(runReleaseAssets(tag, digest).status, 0, 'existing tag output is not overwritten');
    assert.deepEqual(readFileSync(join(release, 'compose.yaml')), original);
  });
});

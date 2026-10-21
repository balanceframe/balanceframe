import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
function render({ overlay = false, profile = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'receipt-ocr-compose-'));
  try {
    const envFile = join(directory, 'private.env');
    writeFileSync(
      envFile,
      'BALANCEFRAME_IMAGE_REF=balanceframe:ocr-sentinel\nACTUAL_SECRET_KEY=private-actual-sentinel\nBETTER_AUTH_SECRET=private-auth-sentinel\nBETTER_AUTH_URL=http://localhost:3030\n',
      { mode: 0o600 },
    );
    const result = spawnSync(
      process.env.COMPOSE_BIN ?? 'docker',
      [
        ...(process.env.COMPOSE_BIN ? [] : ['compose']),
        '--env-file',
        envFile,
        '--project-directory',
        root,
        '--project-name',
        'receipt-ocr-offline',
        '-f',
        join(root, 'compose.yaml'),
        ...(overlay ? ['-f', join(root, 'compose.ocr.yaml')] : []),
        ...(profile ? ['--profile', 'receipt-ocr'] : []),
        'config',
        '--format',
        'json',
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          DOCKER_CONFIG: directory,
          TMPDIR: directory,
        },
      },
    );
    expect(result.status, 'explicit Compose manifests must render offline').toBe(0);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('optional deployment isolation', () => {
  it('core-only deployment has no OCR URL, image, build or dependency', () => {
    const config = render();
    expect(Object.keys(config.services)).toEqual(['balanceframe']);
    const core = config.services.balanceframe;
    expect(core.environment.BALANCEFRAME_RECEIPT_OCR_URL).toBeUndefined();
    expect(core.depends_on).toBeUndefined();
    expect(Object.keys(core.networks)).toEqual(['default']);
    expect(config.networks.default.external).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(root, 'packages/receipt-ocr/package.json'), 'utf8'),
    );
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.scripts.build).toBe(
      'node --check src/extract.mjs && node --check src/server.mjs && node --check src/cli.mjs',
    );
    expect(readFileSync(join(root, 'Dockerfile'), 'utf8')).not.toMatch(
      /tesseract|leptonica|traineddata/,
    );
  });
  it('requires both selected overlay and explicit receipt-ocr profile', () => {
    expect(render({ profile: true }).services['receipt-ocr']).toBeUndefined();
    expect(render({ overlay: true }).services['receipt-ocr']).toBeUndefined();
    const config = render({ overlay: true, profile: true });
    const core = config.services.balanceframe;
    const ocr = config.services['receipt-ocr'];
    expect(core.environment.BALANCEFRAME_RECEIPT_OCR_URL).toBe('http://receipt-ocr:8088');
    expect(core.depends_on).toBeUndefined();
    expect(Object.keys(core.networks).sort()).toEqual(['default', 'receipt-ocr']);
    expect(Object.keys(ocr.networks)).toEqual(['receipt-ocr']);
    expect(config.networks['receipt-ocr'].internal).toBe(true);
    expect(ocr.ports).toBeUndefined();
    expect(ocr.volumes).toBeUndefined();
    expect(ocr.read_only).toBe(true);
    expect(ocr.user).toBe('1000:1000');
    expect(ocr.cap_drop).toEqual(['ALL']);
    expect(ocr.security_opt).toContain('no-new-privileges:true');
    expect(Number(ocr.mem_limit)).toBe(536870912);
    expect(Number(ocr.cpus)).toBe(1);
    expect(ocr.pids_limit).toBe(32);
    expect(ocr.tmpfs[0]).toContain('noexec,nosuid,nodev,size=32m');
  });
  it('packages approved source/model versions and checksums only in the optional image', () => {
    const dockerfile = readFileSync(join(root, 'packages/receipt-ocr/Dockerfile'), 'utf8');
    for (const sha of [
      '9218e62793116d42a9f6d14cd9348518b27f382096eea3d0f2d1a24616bb5884',
      'fa2b40c5caea96d1bb93a97486262aed8731b69ce25a84a6bf5d25323e33f631',
      '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2',
    ])
      expect(dockerfile).toContain(sha);
    expect(dockerfile).toContain('-DDISABLE_CURL=ON');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('await verifyRuntime()');
    expect(dockerfile).not.toContain('npm install');
  });
});

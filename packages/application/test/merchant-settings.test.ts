import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMerchantResearchSettings } from '../src/merchant-settings.js';

const directories: string[] = [];
const policy = { mode: 'external-allowed' as const, allowedProviderIds: ['valueserp'], maxSearchesPerDay: 20, maxSpendMinorUnitsPerMonth: 100, billingCurrency: 'USD', cacheTtlHours: 24 };
const deployment = () => ({ installation: { id: 'installation-fixture', version: 'installation/1', policy }, credential: { id: 'credential-fixture', version: 'credential/1', limits: { maxSearchesPerDay: 30, maxSpendMinorUnitsPerMonth: 200 } }, tariff: { version: 'account-confirmed/1', billingCurrency: 'USD', costAtoms: '250000' } });
function file(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'merchant-settings-')); directories.push(directory);
  const path = join(directory, 'settings.json'); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); return path;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
describe('server-owned merchant deployment settings', () => {
  it('keeps local inference available without configuration or a provider key', () => {
    const result = loadMerchantResearchSettings({ env: {} });
    expect(result.installation.value.mode).toBe('local-only'); expect(result.configuration).toBeNull();
    expect(result.installation.value.allowedProviderIds).toEqual([]);
  });
  it('requires both separately supplied server credential and account-confirmed deployment pricing', () => {
    const path = file(deployment());
    expect(loadMerchantResearchSettings({ configPath: path, env: {} }).configuration).toBeNull();
    const result = loadMerchantResearchSettings({ configPath: path, env: { VALUESERP_API_KEY: 'test-only-secret' } });
    expect(result.installation).toEqual({ version: 'installation/1', value: policy });
    expect(result.configuration).toEqual({ installationId: 'installation-fixture', installationVersion: 'installation/1', installationPolicy: policy,
      credentialId: 'credential-fixture', credentialVersion: 'credential/1', credentialLimits: deployment().credential.limits, tariff: deployment().tariff, apiKey: 'test-only-secret' });
  });
  it('supports installation off without a credential, tariff or external request', () => {
    const path = file({ installation: { ...deployment().installation, policy: { ...policy, mode: 'disabled' } }, credential: null, tariff: null });
    const result = loadMerchantResearchSettings({ configPath: path, env: {} });
    expect(result.installation.value.mode).toBe('disabled'); expect(result.configuration).toBeNull();
  });
  it.each(['missing', 'broken', 'oversized'])('fails closed without exposing file or secret content for %s settings', (kind) => {
    const path = kind === 'missing' ? `${file(deployment())}.absent` : file(kind === 'broken' ? '{"apiKey":"PRIVATE-SECRET"' : 'x'.repeat(65537));
    const result = loadMerchantResearchSettings({ configPath: path, env: { VALUESERP_API_KEY: 'PRIVATE-SECRET' } });
    expect(result.configuration).toBeNull(); expect(result.installation.value.mode).toBe('local-only');
    expect(JSON.stringify(result)).not.toContain('PRIVATE-SECRET');
  });
  it.each(['secret-in-file', 'unknown-endpoint', 'calendar', 'bad-tariff', 'negative-cap', 'unsafe-cap'])('rejects unsupported or secret-bearing deployment fields: %s', (kind) => {
    const value: Record<string, unknown> = deployment();
    if (kind === 'secret-in-file') value.apiKey = 'PRIVATE-FILE-KEY';
    if (kind === 'unknown-endpoint') value.endpoint = 'https://attacker.example/collect';
    if (kind === 'calendar') value.installation = { ...deployment().installation, policy: { ...policy, calendar: { budget: null, accounts: [] } } };
    if (kind === 'bad-tariff') value.tariff = { ...deployment().tariff, costAtoms: '0.25' };
    if (kind === 'negative-cap' || kind === 'unsafe-cap') value.credential = { ...deployment().credential, limits: { ...deployment().credential.limits, maxSearchesPerDay: kind === 'negative-cap' ? -1 : Number.MAX_SAFE_INTEGER + 1 } };
    expect(loadMerchantResearchSettings({ configPath: file(value), env: { VALUESERP_API_KEY: 'test-only' } }).configuration).toBeNull();
  });
  it('preserves exact fractional pricing and stable installation/credential identities across key rotation', () => {
    const path = file(deployment());
    const first = loadMerchantResearchSettings({ configPath: path, env: { VALUESERP_API_KEY: 'key-one' } }).configuration!;
    const second = loadMerchantResearchSettings({ env: { BALANCEFRAME_MERCHANT_CONFIG_PATH: path, VALUESERP_API_KEY: 'key-two' } }).configuration!;
    expect(first.tariff.costAtoms).toBe('250000'); expect(second.tariff).toEqual(first.tariff);
    expect(second.installationId).toBe(first.installationId); expect(second.credentialId).toBe(first.credentialId); expect(second.apiKey).toBe('key-two');
  });
  it.each(['', ' key-with-space ', 'key\nheader', 'x'.repeat(513)])('never enables malformed provider credentials', (apiKey) => {
    expect(loadMerchantResearchSettings({ configPath: file(deployment()), env: { VALUESERP_API_KEY: apiKey } }).configuration).toBeNull();
  });
});

import type { MerchantPolicyValue } from '@balanceframe/workflow-store';
import type { MerchantResearchConfiguration } from './merchant-research.js';
import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { merchantPolicyValueSchema } from '@balanceframe/workflow-store';
import { merchantResearchConfigurationSchema } from './merchant-research.js';

/** Server-owned installation policy remains available independently of provider credentials. */
export interface MerchantResearchSettings {
  installation: { version: string; value: MerchantPolicyValue };
  configuration: MerchantResearchConfiguration | null;
}

const shape = merchantResearchConfigurationSchema.shape;
const deploymentSchema = z.object({
  installation: z.object({ id: shape.installationId, version: shape.installationVersion,
    policy: merchantPolicyValueSchema.refine((value) => value.calendar === undefined) }).strict(),
  credential: z.object({ id: shape.credentialId, version: shape.credentialVersion, limits: shape.credentialLimits }).strict().nullable().optional(),
  tariff: shape.tariff.nullable().optional(),
}).strict();
const localSettings = (): MerchantResearchSettings => ({
  installation: { version: 'unconfigured', value: { mode: 'local-only', allowedProviderIds: [],
    maxSearchesPerDay: 0, maxSpendMinorUnitsPerMonth: 0, billingCurrency: 'USD', cacheTtlHours: 720 } },
  configuration: null,
});
/** Read bounded server deployment settings; provider secrets come only from the server environment. */
export function loadMerchantResearchSettings(options: { configPath?: string; env?: typeof process.env } = {}): MerchantResearchSettings {
  const env = options.env ?? process.env;
  const path = options.configPath ?? env.BALANCEFRAME_MERCHANT_CONFIG_PATH;
  if (!path) return localSettings();
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 65536) return localSettings();
    const parsed = deploymentSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success) return localSettings();
    const { installation, credential, tariff } = parsed.data;
    const result: MerchantResearchSettings = { installation: { version: installation.version, value: installation.policy }, configuration: null };
    if (credential && tariff && env.VALUESERP_API_KEY) {
      const config = merchantResearchConfigurationSchema.safeParse({
        installationId: installation.id, installationVersion: installation.version, installationPolicy: installation.policy,
        credentialId: credential.id, credentialVersion: credential.version, credentialLimits: credential.limits,
        tariff, apiKey: env.VALUESERP_API_KEY,
      });
      if (config.success) result.configuration = config.data;
    }
    return result;
  } catch {
    // Secret-bearing parse/file causes never enter public errors or logs.
    return localSettings();
  }
}

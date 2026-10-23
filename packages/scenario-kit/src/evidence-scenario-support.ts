import { existsSync, readFileSync } from 'node:fs';
import type { ResourceCapability, ResourceKind } from '@balanceframe/workflow-store';
import type { MaterializedScenario } from './catalog.js';
import type { SeededActualBudget } from './actual-seed.js';
import type { ScenarioProcesses } from './process-runtime.js';
import type { ScenarioHttpClient, ScenarioPersonaCredentials } from './workflow-setup.js';

/** Private setup context; every mutation still crosses the normal authenticated API. */
export interface EvidenceScenarioSetup {
  readonly scenario: MaterializedScenario;
  readonly seeded: SeededActualBudget;
  readonly processes: ScenarioProcesses;
  readonly clients: Readonly<Record<string, ScenarioHttpClient>>;
  readonly personas: Readonly<Record<string, ScenarioPersonaCredentials>>;
}

/** Canonical files packaged with the executable evidence scenarios. */
export const EVIDENCE_SCENARIO_FIXTURES = [
  'transaction-evidence-receipt', 'transaction-evidence', 'evidence-allocation-plan',
  'evidence-allocation-resolution', 'evidence-settlement-plan', 'wallet-statement',
  'wallet-statement-preview', 'transaction-evidence-item-learning',
  'transaction-evidence-rule', 'transaction-evidence-rule-context',
  'scenarios/evidence-receipt-assets',
] as const;

/** Load only registered fictional protocol inputs, never runner-private files. */
export function evidenceFixture(name: string): unknown {
  if (!EVIDENCE_SCENARIO_FIXTURES.some((candidate) => candidate === name))
    throw new Error('Expected a registered evidence scenario fixture');
  const candidates = [
    new URL(`../../../protocol/fixtures/${name}.json`, import.meta.url),
    new URL(`../../protocol/fixtures/${name}.json`, import.meta.url),
  ];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) throw new Error(`Evidence scenario fixture ${name} is unavailable`);
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

/** Refuse failed envelopes rather than counting an error response as a seeded state. */
export function evidenceValue(body: unknown, label: string): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
    !('status' in body) || body.status !== 'ok' || !('result' in body))
    throw new Error(`${label} did not return a successful result`);
  return body.result;
}

/** Require an object result before reading runtime identifiers. */
export function evidenceResult(body: unknown, label: string): Record<string, unknown> {
  const value = evidenceValue(body, label);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} did not return an object`);
  return value as Record<string, unknown>;
}

/** Check a returned selector before retaining it in the private logical-ID map. */
export function evidenceString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${label} must be a nonempty string`);
  return value;
}

/** Submit an owner setup action with fresh proof and retain the normal envelope checks. */
export async function evidencePost<T = Record<string, unknown>>(
  context: EvidenceScenarioSetup, path: string, body: Record<string, unknown>,
): Promise<T> {
  const owner = context.clients.owner;
  const persona = context.personas.owner;
  if (!owner || !persona) throw new Error('Evidence scenario owner is unavailable');
  if (!path.startsWith('/api/')) throw new Error('Evidence scenario requires an application API path');
  await owner.reauthenticate(persona.password);
  return evidenceValue(await owner.post(path, body), path) as T;
}

/** Grant only an initializer's validated exact resource through ordinary owner control. */
export async function evidenceGrant(
  context: EvidenceScenarioSetup, personaId: string, resourceKind: ResourceKind,
  resourceId: string, capabilities: readonly ResourceCapability[],
): Promise<void> {
  const owner = context.clients.owner;
  const principal = context.personas.owner;
  const persona = context.personas[personaId];
  if (!owner || !principal || !persona || persona.spaceId !== principal.spaceId)
    throw new Error('Evidence scenario grant persona is unavailable');
  evidenceString(resourceId, 'Evidence scenario resource ID');
  await owner.reauthenticate(principal.password);
  for (const capability of capabilities)
    evidenceResult(await owner.put(`/api/spaces/${principal.spaceId}/grants`, {
      membershipId: persona.membershipId, resourceKind, resourceId, capability, granted: true,
    }), 'Evidence scenario resource grant');
}

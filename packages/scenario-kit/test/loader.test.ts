import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import * as actualSdk from '@actual-app/api';

import * as processRuntime from '../src/process-runtime.js';
import { loadScenario, stopScenario, type LoadedScenario } from '../src/loader.js';
import {
  assertScenarioProcessesActive,
  createOwnedScenarioRoot,
  discardOwnedScenarioRoot,
  stopScenarioProcesses,
  type ScenarioProcesses,
} from '../src/process-runtime.js';

vi.mock('@actual-app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof actualSdk>();
  return {
    ...actual,
    get internal() { return actual.internal; },
    shutdown: vi.fn(actual.shutdown),
    createAccount: vi.fn(actual.createAccount),
  };
});

function failNextShutdownAfterClose(failure: Error): () => Promise<void> {
  const shutdown = vi.mocked(actualSdk.shutdown);
  const realShutdown = shutdown.getMockImplementation();
  if (!realShutdown) throw new Error('Actual SDK shutdown delegate is unavailable');
  shutdown.mockImplementationOnce(async () => {
    await realShutdown();
    throw failure;
  });
  return realShutdown;
}


describe('disposable scenario loader', () => {
  it('removes its allocated root if public-origin validation fails before shell startup', async () => {
    const root = createOwnedScenarioRoot();
    await expect(loadScenario({
      scenarioId: 'funded-purchase',
      root,
      anchor: new Date(),
      publicOrigin: 'http://127.0.0.1:3003/untrusted-path',
    })).rejects.toThrow(/origin/i);
    expect(existsSync(root)).toBe(false);
  });
  it('retains its owned root when SDK shutdown cannot be proven and stops its children', async () => {
    const root = createOwnedScenarioRoot();
    const started: ScenarioProcesses[] = [];
    const startShell = processRuntime.startScenarioShell;
    const start = vi.spyOn(processRuntime, 'startScenarioShell').mockImplementation(async (options) => {
      const processes = await startShell(options);
      started.push(processes);
      return processes;
    });
    const shutdownFailure = new Error(`private shutdown detail ${root}`);
    const shutdown = vi.mocked(actualSdk.shutdown);
    const realShutdown = failNextShutdownAfterClose(shutdownFailure);
    let loaded: LoadedScenario | undefined;
    let failure: unknown;
    try {
      try {
        loaded = await loadScenario({
          scenarioId: 'funded-purchase',
          root,
          anchor: new Date(),
          publicOrigin: 'http://127.0.0.1:3003',
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ code: 'cleanup_unproven', ownedCleanupUnproven: true });
      expect((failure as Error).message).toBe('Actual SDK cleanup could not be proven');
      expect((failure as Error).message).not.toContain(root);
      expect((failure as Error).message).not.toContain(shutdownFailure.message);
      expect(failure).not.toHaveProperty('cause');
      expect(existsSync(root)).toBe(true);
      expect(started).toHaveLength(1);
      expect(() => assertScenarioProcessesActive(started[0]!))
        .toThrow('Scenario process handle is not active');
    } finally {
      shutdown.mockReset().mockImplementation(realShutdown);
      start.mockRestore();
      await actualSdk.shutdown().catch(() => undefined);
      if (loaded) await stopScenario(loaded);
      for (const processes of started)
        await stopScenarioProcesses(processes, { retainRoot: true });
      if (existsSync(root)) discardOwnedScenarioRoot(root);
    }
  }, 180_000);

  it('cleans a shutdown-proven seed failure so a fresh owned load can retry', async () => {
    const root = createOwnedScenarioRoot();
    const createAccount = vi.mocked(actualSdk.createAccount);
    const realCreateAccount = createAccount.getMockImplementation();
    if (!realCreateAccount) throw new Error('Actual SDK account delegate is unavailable');
    createAccount.mockRejectedValueOnce(new Error('ordinary seed failure'));
    let loaded: LoadedScenario | undefined;
    let failure: unknown;
    try {
      try {
        loaded = await loadScenario({
          scenarioId: 'funded-purchase',
          root,
          anchor: new Date(),
          publicOrigin: 'http://127.0.0.1:3003',
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ message: 'ordinary seed failure' });
      expect(failure).not.toHaveProperty('ownedCleanupUnproven');
      expect(existsSync(root)).toBe(false);
    } finally {
      createAccount.mockReset().mockImplementation(realCreateAccount);
      if (loaded) await stopScenario(loaded);
      await actualSdk.shutdown().catch(() => undefined);
      if (existsSync(root)) discardOwnedScenarioRoot(root);
    }

    const retryRoot = createOwnedScenarioRoot();
    const retried = await loadScenario({
      scenarioId: 'funded-purchase',
      root: retryRoot,
      anchor: new Date(),
      publicOrigin: 'http://127.0.0.1:3003',
    });
    try {
      expect(retried.scenario.id).toBe('funded-purchase');
    } finally {
      await stopScenario(retried);
    }
    expect(existsSync(retryRoot)).toBe(false);
  }, 240_000);


  it('serves a funded native Card through the normally authenticated web API and removes its owned stack', async () => {
    const root = createOwnedScenarioRoot();
    const publicOrigin = 'http://127.0.0.1:3003';
    const loaded = await loadScenario({
      scenarioId: 'funded-purchase',
      root,
      anchor: new Date(),
      publicOrigin,
    });
    try {
      expect(loaded.scenario.entry.kind).toBe('purchase');
      if (loaded.scenario.entry.kind !== 'purchase') throw new Error('Expected purchase entry');
      const input = loaded.scenario.entry.input;
      const categoryId = loaded.seeded.categoryIds[input.categoryId];
      const accountId = input.accountId ? loaded.seeded.accountIds[input.accountId] : undefined;
      expect(categoryId).toBeTruthy();
      expect(accountId).toBeTruthy();
      const url = new URL('/api/purchase/evaluate', loaded.processes.webUrl);
      url.searchParams.set('categoryId', categoryId!);
      url.searchParams.set('accountId', accountId!);
      url.searchParams.set('amount', input.amount.minorUnits);
      url.searchParams.set('currency', input.amount.currency);
      const response = await fetch(url, {
        headers: {
          Host: new URL(publicOrigin).host,
          Origin: publicOrigin,
          Cookie: loaded.initialized.personas.owner!.cookieHeader,
          'x-balanceframe-space': loaded.initialized.spaceId,
        },
      });
      expect(response.status).toBe(200);
      const payload = await response.json() as {
        status: string;
        result?: {
          card?: {
            outcome?: string;
            budgetFundingStatus?: string;
            paymentLiquidityStatus?: string;
            selectedAccountId?: string;
            before?: { accounts?: Array<{accountId: string; safeSpendingCapacity: {minorUnits: string}}> };
            after?: { categories?: Array<{categoryId: string; availability: {minorUnits: string}}>;
              accounts?: Array<{accountId: string; safeSpendingCapacity: {minorUnits: string}}> };
          };
        };
      };
      expect(payload.status).toBe('ok');
      expect(payload.result?.card).toMatchObject({
        outcome: 'funded_now',
        budgetFundingStatus: 'funded',
        paymentLiquidityStatus: 'ready',
        selectedAccountId: accountId,
      });
      expect(payload.result?.card?.before?.accounts).toEqual(expect.arrayContaining([
        expect.objectContaining({ accountId, safeSpendingCapacity: { minorUnits: '5000', currency: 'USD' } }),
      ]));
      expect(payload.result?.card?.after?.categories).toEqual(expect.arrayContaining([
        expect.objectContaining({ categoryId, availability: { minorUnits: '0', currency: 'USD' } }),
      ]));
      expect(payload.result?.card?.after?.accounts).toEqual(expect.arrayContaining([
        expect.objectContaining({ accountId, safeSpendingCapacity: { minorUnits: '3000', currency: 'USD' } }),
      ]));
    } finally {
      await stopScenario(loaded);
    }
    expect(existsSync(root)).toBe(false);
  }, 120_000);

  it.each([
    ['governance-scoped-access', '/spaces'],
    ['merchant-local-sparse', '/review'],
    ['merchant-native-rule-lifecycle', '/rules'],
    ['merchant-research-success', '/review'],
  ])('loads %s under a private ready manifest without enabling public demo mode', async (scenarioId, path) => {
    const root = createOwnedScenarioRoot();
    const publicOrigin = 'http://127.0.0.1:3003';
    const loaded = await loadScenario({ scenarioId, root, anchor: new Date('2026-09-06T12:00:00.000Z'), publicOrigin });
    try {
      const manifest = JSON.parse(await readFile(loaded.processes.manifestPath, 'utf8')) as {
        phase: string; scenarioId: string; spaceId: string; actorIds: string[]; internalSecret: string;
      };
      expect((await stat(loaded.processes.manifestPath)).mode & 0o777).toBe(0o600);
      expect(manifest).toMatchObject({
        phase: 'ready', scenarioId, spaceId: loaded.initialized.spaceId,
        actorIds: Object.values(loaded.initialized.personas).map((persona) => persona.actorId),
        internalSecret: loaded.processes.internalSecret,
      });
      expect(loaded.initialized.entry).toEqual({ kind: 'page', path });
      const owner = loaded.initialized.personas.owner!;
      const headers = {
        Host: new URL(publicOrigin).host, Origin: publicOrigin,
        Cookie: owner.cookieHeader, 'x-balanceframe-space': loaded.initialized.spaceId,
      };
      const selector = await fetch(new URL('/demo', loaded.processes.webUrl), { headers });
      expect(selector.status).toBe(200);
      expect(await selector.text()).not.toMatch(/data-action="(?:open-scenario|reset)"/);
      const supervisorState = await fetch(new URL('/__demo/state', loaded.processes.webUrl), { headers });
      expect(await supervisorState.json().catch(() => ({}))).not.toHaveProperty('generation');
      const page = await fetch(new URL(path, loaded.processes.webUrl), { headers });
      expect(page.status).toBe(200);
      const budgetDiscovery = await fetch(new URL('/api/connection/budgets', loaded.processes.webUrl), { headers });
      expect(budgetDiscovery.status).toBe(403);
      expect(await budgetDiscovery.json()).not.toHaveProperty('result.budgets');
      const connection = await fetch(new URL('/api/connection', loaded.processes.webUrl), {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}',
      });
      expect(connection.status).toBe(403);
      const forgedSetup = await fetch(new URL('/api/auth/api-key/create', loaded.processes.webUrl), {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'x-balanceframe-demo-internal': loaded.processes.internalSecret },
        body: '{}',
      });
      expect(forgedSetup.status).toBe(403);
    } finally {
      await stopScenario(loaded);
    }
    expect(existsSync(root)).toBe(false);
  }, 180_000);
});

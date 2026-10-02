import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { loadScenario, stopScenario } from '../src/loader.js';
import { createOwnedScenarioRoot } from '../src/process-runtime.js';

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
});

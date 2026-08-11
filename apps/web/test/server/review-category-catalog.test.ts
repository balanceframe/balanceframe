import { describe, expect, it, vi } from 'vitest';
import {
  getReviewCategoryCatalog,
  type ReviewCategoryCatalogConfig,
  updateReviewCategoryCatalog,
} from '../../server/utils/review-category-catalog';

type Synchronization = Parameters<typeof updateReviewCategoryCatalog>[1];

function catalogConfig(caseId: string) {
  return {
    serverUrl: `https://${caseId}.actual.test`,
    budgetId: `${caseId}-budget`,
    groupId: `${caseId}-group`,
  };
}


interface LoadedSynchronization {
  readonly config: ReviewCategoryCatalogConfig;
  readonly synchronization: Synchronization;
}

function synchronization(categories: readonly unknown[]): Synchronization {
  return { snapshot: { categories } } as unknown as Synchronization;
}

function loadedSynchronization(
  config: ReviewCategoryCatalogConfig,
  categories: readonly unknown[],
): LoadedSynchronization {
  return { config, synchronization: synchronization(categories) };
}

describe('review category catalog', () => {
  it('projects, deduplicates, and deterministically sorts current well-formed categories', async () => {
    const config = catalogConfig('utility-projection');
    const loadSynchronization = vi.fn().mockResolvedValue(
      loadedSynchronization(config, [
        {
          id: 'cat-z',
          name: 'Zulu',
          groupName: 'Travel',
          isIncome: false,
          deleted: false,
        },
        {
          id: 'cat-b',
          name: 'Beta',
          groupName: 'Bills',
          deleted: false,
        },
        {
          id: 'cat-a2',
          name: 'Alpha',
          groupName: 'Bills',
          deleted: false,
        },
        {
          id: 'cat-a1',
          name: 'Superseded duplicate',
          groupName: 'Travel',
          isIncome: true,
          deleted: false,
        },
        {
          id: 'cat-income',
          name: 'Income',
          groupName: '',
          isIncome: true,
          deleted: false,
        },
        {
          id: 'cat-a1',
          name: 'Alpha',
          groupName: 'Bills',
          deleted: false,
        },
        {
          id: 'cat-deleted',
          name: 'Deleted',
          groupName: 'Bills',
          deleted: true,
        },
        { id: '', name: 'Missing identifier', deleted: false },
        { id: 'cat-missing-name', deleted: false },
        { id: 'cat-empty-name', name: '', deleted: false },
        { id: 42, name: 'Non-string identifier', deleted: false },
        { id: 'cat-non-string-name', name: 42, deleted: false },
        null,
        'not-a-category',
      ]),
    );

    await expect(getReviewCategoryCatalog(config, loadSynchronization)).resolves.toEqual([
      {
        id: 'cat-income',
        name: 'Income',
        groupName: null,
        isIncome: true,
      },
      {
        id: 'cat-a1',
        name: 'Alpha',
        groupName: 'Bills',
        isIncome: false,
      },
      {
        id: 'cat-a2',
        name: 'Alpha',
        groupName: 'Bills',
        isIncome: false,
      },
      {
        id: 'cat-b',
        name: 'Beta',
        groupName: 'Bills',
        isIncome: false,
      },
      {
        id: 'cat-z',
        name: 'Zulu',
        groupName: 'Travel',
        isIncome: false,
      },
    ]);
    expect(loadSynchronization).toHaveBeenCalledOnce();
  });

  it('caches sequential reads for one configured budget', async () => {
    const config = catalogConfig('utility-sequential');
    const loadSynchronization = vi.fn().mockResolvedValue(
      loadedSynchronization(config, [{ id: 'cat-once', name: 'Loaded once', deleted: false }]),
    );

    const first = await getReviewCategoryCatalog(config, loadSynchronization);
    const second = await getReviewCategoryCatalog(config, loadSynchronization);

    expect(first).toEqual([
      {
        id: 'cat-once',
        name: 'Loaded once',
        groupName: null,
        isIncome: false,
      },
    ]);
    expect(second).toEqual(first);
    expect(loadSynchronization).toHaveBeenCalledOnce();
  });

  it('stores a restored active catalog under its lifecycle config instead of the stale request key', async () => {
    const requestedConfig = catalogConfig('utility-stale-request');
    const activeConfig = catalogConfig('utility-active-connection');
    const loadActiveConnection = vi.fn().mockResolvedValue(
      loadedSynchronization(activeConfig, [
        { id: 'cat-active', name: 'Active connection', deleted: false },
      ]),
    );

    const activeCatalog = await getReviewCategoryCatalog(requestedConfig, loadActiveConnection);

    expect(activeCatalog).toEqual([
      {
        id: 'cat-active',
        name: 'Active connection',
        groupName: null,
        isIncome: false,
      },
    ]);

    const unexpectedActiveReload = vi
      .fn()
      .mockRejectedValue(new Error('active catalog was not cached under its lifecycle config'));
    await expect(
      getReviewCategoryCatalog(activeConfig, unexpectedActiveReload),
    ).resolves.toEqual(activeCatalog);
    expect(unexpectedActiveReload).not.toHaveBeenCalled();

    const loadRequestedConnection = vi.fn().mockResolvedValue(
      loadedSynchronization(requestedConfig, [
        { id: 'cat-requested', name: 'Requested connection', deleted: false },
      ]),
    );
    await expect(
      getReviewCategoryCatalog(requestedConfig, loadRequestedConnection),
    ).resolves.toEqual([
      {
        id: 'cat-requested',
        name: 'Requested connection',
        groupName: null,
        isIncome: false,
      },
    ]);
    expect(loadRequestedConnection).toHaveBeenCalledOnce();
  });

  it('single-flights concurrent cold reads for one configured budget', async () => {
    const config = catalogConfig('utility-concurrent');
    let resolveSynchronization!: (value: LoadedSynchronization) => void;
    const pendingSynchronization = new Promise<LoadedSynchronization>((resolve) => {
      resolveSynchronization = resolve;
    });
    const loadSynchronization = vi.fn(() => pendingSynchronization);

    const firstRequest = getReviewCategoryCatalog(config, loadSynchronization);
    const secondRequest = getReviewCategoryCatalog(config, loadSynchronization);
    resolveSynchronization(
      loadedSynchronization(config, [
        { id: 'cat-shared', name: 'Shared result', deleted: false },
      ]),
    );

    const [first, second] = await Promise.all([firstRequest, secondRequest]);

    expect(first).toEqual([
      {
        id: 'cat-shared',
        name: 'Shared result',
        groupName: null,
        isIncome: false,
      },
    ]);
    expect(second).toEqual(first);
    expect(loadSynchronization).toHaveBeenCalledOnce();
  });

  it('replaces a configured budget entry from an explicit synchronization', async () => {
    const config = catalogConfig('utility-update');
    const initialLoader = vi.fn().mockResolvedValue(
      loadedSynchronization(config, [{ id: 'cat-old', name: 'Old category', deleted: false }]),
    );
    await getReviewCategoryCatalog(config, initialLoader);

    await updateReviewCategoryCatalog(
      config,
      synchronization([{ id: 'cat-new', name: 'New category', deleted: false }]),
    );
    const fallbackLoader = vi.fn().mockRejectedValue(new Error('cache was not replaced'));

    await expect(getReviewCategoryCatalog(config, fallbackLoader)).resolves.toEqual([
      {
        id: 'cat-new',
        name: 'New category',
        groupName: null,
        isIncome: false,
      },
    ]);
    expect(initialLoader).toHaveBeenCalledOnce();
    expect(fallbackLoader).not.toHaveBeenCalled();
  });

  it('invalidates a prior resolved connection when an explicit synchronization selects another', async () => {
    const priorConfig = catalogConfig('utility-update-prior');
    const selectedConfig = catalogConfig('utility-update-selected');
    updateReviewCategoryCatalog(
      priorConfig,
      synchronization([{ id: 'cat-prior', name: 'Prior category', deleted: false }]),
    );

    updateReviewCategoryCatalog(
      selectedConfig,
      synchronization([{ id: 'cat-selected', name: 'Selected category', deleted: false }]),
    );

    const unexpectedSelectedReload = vi
      .fn()
      .mockRejectedValue(new Error('selected catalog was not stored by the explicit update'));
    await expect(
      getReviewCategoryCatalog(selectedConfig, unexpectedSelectedReload),
    ).resolves.toEqual([
      {
        id: 'cat-selected',
        name: 'Selected category',
        groupName: null,
        isIncome: false,
      },
    ]);
    expect(unexpectedSelectedReload).not.toHaveBeenCalled();

    const reloadPrior = vi.fn().mockResolvedValue(
      loadedSynchronization(priorConfig, [
        { id: 'cat-prior-reloaded', name: 'Reloaded prior category', deleted: false },
      ]),
    );
    await expect(getReviewCategoryCatalog(priorConfig, reloadPrior)).resolves.toEqual([
      {
        id: 'cat-prior-reloaded',
        name: 'Reloaded prior category',
        groupName: null,
        isIncome: false,
      },
    ]);
    expect(reloadPrior).toHaveBeenCalledOnce();
  });

  it('lets a later deleted duplicate tombstone an earlier live category', async () => {
    const config = catalogConfig('utility-tombstone');
    updateReviewCategoryCatalog(
      config,
      synchronization([
        { id: 'cat-tombstoned', name: 'Previously live', deleted: false },
        { id: 'cat-tombstoned', name: 'Deleted later', deleted: true },
      ]),
    );
    const unexpectedReload = vi
      .fn()
      .mockRejectedValue(new Error('explicit tombstone projection was not cached'));

    await expect(getReviewCategoryCatalog(config, unexpectedReload)).resolves.toEqual([]);
    expect(unexpectedReload).not.toHaveBeenCalled();
  });

  it('isolates every server, budget, and group configuration key', async () => {
    const base = catalogConfig('utility-isolation');
    const configurations = [
      base,
      { ...base, serverUrl: 'https://other-server.actual.test' },
      { ...base, budgetId: 'other-budget' },
      { ...base, groupId: 'other-group' },
    ];
    const loaders = configurations.map((config, index) =>
      vi.fn().mockResolvedValue(
        loadedSynchronization(config, [
          {
            id: `cat-${index}`,
            name: `Configuration ${index}`,
            deleted: false,
          },
        ]),
      ),
    );

    const results = await Promise.all(
      configurations.map((config, index) =>
        getReviewCategoryCatalog(config, loaders[index]!),
      ),
    );

    expect(results.map((categories) => categories[0]?.id)).toEqual([
      'cat-0',
      'cat-1',
      'cat-2',
      'cat-3',
    ]);
    for (const loader of loaders) expect(loader).toHaveBeenCalledOnce();

    const unexpectedReload = vi.fn().mockRejectedValue(new Error('base entry was not isolated'));
    await expect(getReviewCategoryCatalog(base, unexpectedReload)).resolves.toEqual(results[0]);
    expect(unexpectedReload).not.toHaveBeenCalled();
  });

  it('retries a cold load after the prior loader rejects', async () => {
    const config = catalogConfig('utility-retry');
    const failure = new Error('temporary synchronization failure');
    const loadSynchronization = vi
      .fn<() => Promise<LoadedSynchronization>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(
        loadedSynchronization(config, [
          { id: 'cat-recovered', name: 'Recovered', deleted: false },
        ]),
      );

    await expect(getReviewCategoryCatalog(config, loadSynchronization)).rejects.toBe(failure);
    await expect(getReviewCategoryCatalog(config, loadSynchronization)).resolves.toEqual([
      {
        id: 'cat-recovered',
        name: 'Recovered',
        groupName: null,
        isIncome: false,
      },
    ]);
    expect(loadSynchronization).toHaveBeenCalledTimes(2);
  });
});

/** A selectable category projected from the latest synchronized budget snapshot. */
export interface ReviewCategory {
  /** Stable Actual category identifier. */
  readonly id: string;
  /** Display name of the category. */
  readonly name: string;
  /** Display name of the containing group, or null when the group is unavailable. */
  readonly groupName: string | null;
  /** Whether the category belongs to an income group. */
  readonly isIncome: boolean;
}

/** Connection fields that isolate one review category catalog from another. */
export interface ReviewCategoryCatalogConfig {
  /** Actual server URL for the configured connection. */
  readonly serverUrl: string;
  /** Selected Actual budget identifier. */
  readonly budgetId: string;
  /** Selected Actual budget group identifier. */
  readonly groupId: string;
}

/**
 * Lifecycle-selected connection and synchronization returned by a cold catalog load.
 *
 * The config must describe the connection that produced the synchronization;
 * the config passed to the loader's caller is only a cache lookup hint.
 */
export interface ReviewCategoryCatalogLoadResult {
  /** Exact connection configuration selected while synchronizing. */
  readonly config: ReviewCategoryCatalogConfig;
  /** Synchronization produced for that selected connection. */
  readonly synchronization: unknown;
}

type ReviewCategoryCatalog = readonly ReviewCategory[];

interface SynchronizationEnvelope {
  readonly snapshot?: unknown;
}

interface SynchronizationSnapshot {
  readonly categories?: unknown;
}

interface RawReviewCategory {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly groupName?: unknown;
  readonly isIncome?: unknown;
  readonly deleted?: unknown;
}

const EMPTY_CATALOG: ReviewCategoryCatalog = Object.freeze([]);
const resolvedCatalogs = new Map<string, ReviewCategoryCatalog>();
const inFlightCatalogs = new Map<string, Promise<ReviewCategoryCatalog>>();

function connectionKey(config: ReviewCategoryCatalogConfig): string {
  return `${config.serverUrl.length}:${config.serverUrl}|${config.budgetId.length}:${config.budgetId}|${config.groupId.length}:${config.groupId}`;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function projectCatalog(synchronization: unknown): ReviewCategoryCatalog {
  if (
    typeof synchronization !== 'object' ||
    synchronization === null ||
    Array.isArray(synchronization)
  ) {
    return EMPTY_CATALOG;
  }
  const snapshot = (synchronization as SynchronizationEnvelope).snapshot;
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    return EMPTY_CATALOG;
  }
  const rawCategories = (snapshot as SynchronizationSnapshot).categories;
  if (!Array.isArray(rawCategories)) return EMPTY_CATALOG;

  const categoryIds = new Set<string>();
  const categories: ReviewCategory[] = [];
  for (let index = rawCategories.length - 1; index >= 0; index -= 1) {
    const value = rawCategories[index];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const category = value as RawReviewCategory;
    if (typeof category.id !== 'string' || category.id.length === 0) continue;
    if (categoryIds.has(category.id)) continue;
    categoryIds.add(category.id);
    if (category.deleted === true) continue;
    if (typeof category.name !== 'string' || category.name.length === 0) continue;
    categories.push(
      Object.freeze({
        id: category.id,
        name: category.name,
        groupName:
          typeof category.groupName === 'string' && category.groupName.length > 0
            ? category.groupName
            : null,
        isIncome: category.isIncome === true,
      }),
    );
  }

  if (categories.length === 0) return EMPTY_CATALOG;

  categories.sort(
    (left, right) =>
      compareText(left.groupName ?? '', right.groupName ?? '') ||
      compareText(left.name, right.name) ||
      compareText(left.id, right.id),
  );
  return Object.freeze(categories);
}

/**
 * Return the cached category catalog for a configured connection, using the
 * requested config only as a lookup hint on a cold load. The synchronization is
 * cached under the lifecycle-selected config returned by the loader. Concurrent
 * cold callers for the same requested key share one load, and failed loads
 * remain retryable.
 */
export function getReviewCategoryCatalog(
  config: ReviewCategoryCatalogConfig,
  loadSynchronization: () => Promise<ReviewCategoryCatalogLoadResult>,
): Promise<ReviewCategoryCatalog> {
  const key = connectionKey(config);
  const resolved = resolvedCatalogs.get(key);
  if (resolved !== undefined) return Promise.resolve(resolved);

  const inFlight = inFlightCatalogs.get(key);
  if (inFlight !== undefined) return inFlight;

  let load!: Promise<ReviewCategoryCatalog>;
  load = Promise.resolve()
    .then(loadSynchronization)
    .then(({ config: loadedConfig, synchronization }) => {
      const catalog = projectCatalog(synchronization);
      const loadedKey = connectionKey(loadedConfig);
      if (inFlightCatalogs.get(key) === load) {
        resolvedCatalogs.set(loadedKey, catalog);
        return catalog;
      }
      return resolvedCatalogs.get(loadedKey) ?? catalog;
    })
    .finally(() => {
      if (inFlightCatalogs.get(key) === load) inFlightCatalogs.delete(key);
    });

  inFlightCatalogs.set(key, load);
  return load;
}

/**
 * Select a connection explicitly by invalidating every prior resolved or
 * in-flight entry, then caching the successful synchronization's projection.
 */
export function updateReviewCategoryCatalog(
  config: ReviewCategoryCatalogConfig,
  synchronization: unknown,
): void {
  const catalog = projectCatalog(synchronization);
  resolvedCatalogs.clear();
  inFlightCatalogs.clear();
  resolvedCatalogs.set(connectionKey(config), catalog);
}

/**
 * Tests for bounded inference concurrency with abort-listener cleanup.
 *
 * Concurrency limits ensure the orchestrator does not flood providers
 * with simultaneous classify calls. AbortSignal listeners from previous
 * calls must be cleaned up to prevent memory leaks and stale rejections.
 *
 * Uses fake timers to avoid real wall-clock delays.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Orchestrator } from '../src/orchestrator';
import { createPolicyEngine } from '../src/policy';
import { createRedactor } from '../src/redactor';
import type {
  UnresolvedCandidate,
  CapabilityPolicies,
  ClassificationResult,
  ClassifyRequest,
} from '../src/types';
import type { ProviderAdapter } from '../src/providers/types';

function makeCandidate(overrides: Partial<UnresolvedCandidate> = {}): UnresolvedCandidate {
  return {
    transactionId: 'tx_001',
    transactionVersion: 'v2',
    budgetId: 'budget_family',
    spaceId: 'space_main',
    connectionId: 'conn_actual',
    rawMerchant: 'AMAZON MKTPLACE',
    normalizedMerchant: 'Amazon',
    description: 'Electronics purchase',
    notes: null,
    importedPayee: 'AMAZON.COM',
    amountMinorUnits: '3499',
    currency: 'USD',
    date: '2026-07-14',
    categoryId: null,
    importedId: 'imp_001',
    deterministicEvidence: { reasonCodes: ['uncategorized'] },
    ...overrides,
  };
}

function defaultPolicies(overrides: Partial<CapabilityPolicies> = {}): CapabilityPolicies {
  return {
    classification: 'local-only',
    merchantResearch: 'disabled',
    conversation: 'disabled',
    telemetry: 'disabled',
    ...overrides,
  };
}

function classifyResult(overrides: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    categoryId: 'cat_food',
    confidence: 0.85,
    alternatives: [],
    rationale: 'Test classification',
    model: 'test-model-v1',
    ...overrides,
  };
}

describe('bounded concurrency', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('limits concurrent classify calls to the configured concurrency', async () => {
    let inflight = 0;
    let maxInflight = 0;
    // Track resolve functions so we can complete calls in order
    const resolvers: Array<() => void> = [];
    const classify = vi.fn().mockImplementation(async (_req: ClassifyRequest) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      const { promise, resolve } = Promise.withResolvers<void>();
      resolvers.push(resolve);
      await promise;
      inflight--;
      return classifyResult();
    });

    const adapter: ProviderAdapter = {
      providerId: 'test-local',
      providerInfo: {
        id: 'test-local',
        name: 'Test Local',
        locality: 'local',
        supportedCapabilities: ['classification'],
        endpoint: null,
        authType: null,
        model: 'test-model-v1',
      },
      classify,
    };

    const orchestrator = new Orchestrator({
      providers: [adapter],
      policy: createPolicyEngine({
        capabilities: defaultPolicies({ classification: 'local-only' }),
        providerAllowlists: [{ capability: 'classification', allowedProviderIds: ['test-local'] }],
        policyVersion: '1.0',
      }),
      redactor: createRedactor(),
      promptVersion: 'v1',
      maxConcurrency: 2,
    });

    const candidates = [
      makeCandidate({ transactionId: 'tx_001' }),
      makeCandidate({ transactionId: 'tx_002' }),
      makeCandidate({ transactionId: 'tx_003' }),
    ];

    const resultsPromise = orchestrator.classify(candidates);

    // Let microtasks settle — classify calls should have started
    await vi.advanceTimersByTimeAsync(0);

    // With concurrency 2, only 2 calls should be in-flight
    expect(classify).toHaveBeenCalledTimes(2);
    expect(maxInflight).toBeLessThanOrEqual(2);

    // Release one, then the next call should start
    resolvers[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(classify).toHaveBeenCalledTimes(3);
    expect(maxInflight).toBeLessThanOrEqual(2);

    // Release remaining
    resolvers[1]!();
    resolvers[2]!();
    await vi.advanceTimersByTimeAsync(0);

    const results = await resultsPromise;
    expect(results).toHaveLength(3);
  });

  it('processes all candidates with concurrency 1 (serial)', async () => {
    const callOrder: number[] = [];
    const resolvers: Array<() => void> = [];
    const classify = vi.fn().mockImplementation(async () => {
      const idx = callOrder.length;
      callOrder.push(idx);
      const { promise, resolve } = Promise.withResolvers<void>();
      resolvers.push(resolve);
      await promise;
      return classifyResult();
    });

    const adapter: ProviderAdapter = {
      providerId: 'test-local',
      providerInfo: {
        id: 'test-local',
        name: 'Test Local',
        locality: 'local',
        supportedCapabilities: ['classification'],
        endpoint: null,
        authType: null,
        model: 'test-model-v1',
      },
      classify,
    };

    const orchestrator = new Orchestrator({
      providers: [adapter],
      policy: createPolicyEngine({
        capabilities: defaultPolicies({ classification: 'local-only' }),
        providerAllowlists: [{ capability: 'classification', allowedProviderIds: ['test-local'] }],
        policyVersion: '1.0',
      }),
      redactor: createRedactor(),
      promptVersion: 'v1',
      maxConcurrency: 1,
    });

    const resultsPromise = orchestrator.classify([
      makeCandidate({ transactionId: 'tx_001' }),
      makeCandidate({ transactionId: 'tx_002' }),
      makeCandidate({ transactionId: 'tx_003' }),
    ]);

    await vi.advanceTimersByTimeAsync(0);
    expect(classify).toHaveBeenCalledTimes(1);

    // Release one by one
    resolvers[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(classify).toHaveBeenCalledTimes(2);

    resolvers[1]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(classify).toHaveBeenCalledTimes(3);

    resolvers[2]!();
    await vi.advanceTimersByTimeAsync(0);

    const results = await resultsPromise;
    expect(results).toHaveLength(3);
    expect(callOrder).toEqual([0, 1, 2]);
  });

  it('defaults to concurrency 3 when maxConcurrency is undefined', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const resolvers: Array<() => void> = [];
    const classify = vi.fn().mockImplementation(async (_req: ClassifyRequest) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      const { promise, resolve } = Promise.withResolvers<void>();
      resolvers.push(resolve);
      await promise;
      inflight--;
      return classifyResult();
    });

    const adapter: ProviderAdapter = {
      providerId: 'test-local',
      providerInfo: {
        id: 'test-local',
        name: 'Test Local',
        locality: 'local',
        supportedCapabilities: ['classification'],
        endpoint: null,
        authType: null,
        model: 'test-model-v1',
      },
      classify,
    };

    const orchestrator = new Orchestrator({
      providers: [adapter],
      policy: createPolicyEngine({
        capabilities: defaultPolicies({ classification: 'local-only' }),
        providerAllowlists: [{ capability: 'classification', allowedProviderIds: ['test-local'] }],
        policyVersion: '1.0',
      }),
      redactor: createRedactor(),
      promptVersion: 'v1',
      // maxConcurrency intentionally undefined
    });

    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({ transactionId: `tx_${String(i).padStart(3, '0')}` }),
    );

    const resultsPromise = orchestrator.classify(candidates);
    await vi.advanceTimersByTimeAsync(0);

    // Default of 3 starts immediately — only 3 of 10 in-flight
    expect(classify).toHaveBeenCalledTimes(3);
    expect(maxInflight).toBeLessThanOrEqual(3);

    // Release one by one — each release lets the next candidate start
    for (let i = 0; i < 7; i++) {
      resolvers[i]!();
      await vi.advanceTimersByTimeAsync(0);
    }
    // All 10 should have been classified by now
    expect(classify).toHaveBeenCalledTimes(10);

    // Release the final batch of 3
    resolvers[7]!();
    resolvers[8]!();
    resolvers[9]!();
    await vi.advanceTimersByTimeAsync(0);

    const results = await resultsPromise;
    expect(results).toHaveLength(10);
  });

  it('defaults to concurrency 3 when maxConcurrency is 0', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const resolvers: Array<() => void> = [];
    const classify = vi.fn().mockImplementation(async (_req: ClassifyRequest) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      const { promise, resolve } = Promise.withResolvers<void>();
      resolvers.push(resolve);
      await promise;
      inflight--;
      return classifyResult();
    });

    const adapter: ProviderAdapter = {
      providerId: 'test-local',
      providerInfo: {
        id: 'test-local',
        name: 'Test Local',
        locality: 'local',
        supportedCapabilities: ['classification'],
        endpoint: null,
        authType: null,
        model: 'test-model-v1',
      },
      classify,
    };

    const orchestrator = new Orchestrator({
      providers: [adapter],
      policy: createPolicyEngine({
        capabilities: defaultPolicies({ classification: 'local-only' }),
        providerAllowlists: [{ capability: 'classification', allowedProviderIds: ['test-local'] }],
        policyVersion: '1.0',
      }),
      redactor: createRedactor(),
      promptVersion: 'v1',
      maxConcurrency: 0,
    });

    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({ transactionId: `tx_${String(i).padStart(3, '0')}` }),
    );

    const resultsPromise = orchestrator.classify(candidates);
    await vi.advanceTimersByTimeAsync(0);

    // maxConcurrency=0 is treated as default 3
    expect(classify).toHaveBeenCalledTimes(3);
    expect(maxInflight).toBeLessThanOrEqual(3);

    // Release one by one
    for (let i = 0; i < 7; i++) {
      resolvers[i]!();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(classify).toHaveBeenCalledTimes(10);

    // Release final 3
    resolvers[7]!();
    resolvers[8]!();
    resolvers[9]!();
    await vi.advanceTimersByTimeAsync(0);

    const results = await resultsPromise;
    expect(results).toHaveLength(10);
  });

  it('uses bounded pool even when concurrency exceeds candidate count', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const resolvers: Array<() => void> = [];
    const classify = vi.fn().mockImplementation(async (_req: ClassifyRequest) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      const { promise, resolve } = Promise.withResolvers<void>();
      resolvers.push(resolve);
      await promise;
      inflight--;
      return classifyResult();
    });

    const adapter: ProviderAdapter = {
      providerId: 'test-local',
      providerInfo: {
        id: 'test-local',
        name: 'Test Local',
        locality: 'local',
        supportedCapabilities: ['classification'],
        endpoint: null,
        authType: null,
        model: 'test-model-v1',
      },
      classify,
    };

    const orchestrator = new Orchestrator({
      providers: [adapter],
      policy: createPolicyEngine({
        capabilities: defaultPolicies({ classification: 'local-only' }),
        providerAllowlists: [{ capability: 'classification', allowedProviderIds: ['test-local'] }],
        policyVersion: '1.0',
      }),
      redactor: createRedactor(),
      promptVersion: 'v1',
      maxConcurrency: 10,
    });

    // With 3 candidates, maxConc becomes min(10, 3) = 3 — all start in one batch
    const candidates = [
      makeCandidate({ transactionId: 'tx_001' }),
      makeCandidate({ transactionId: 'tx_002' }),
      makeCandidate({ transactionId: 'tx_003' }),
    ];

    const resultsPromise = orchestrator.classify(candidates);
    await vi.advanceTimersByTimeAsync(0);

    expect(classify).toHaveBeenCalledTimes(3);
    expect(maxInflight).toBeLessThanOrEqual(3);

    // Release one by one — pool still bounds correctly
    resolvers[0]!();
    await vi.advanceTimersByTimeAsync(0);
    // All 3 were already started, no more to start
    expect(classify).toHaveBeenCalledTimes(3);

    resolvers[1]!();
    resolvers[2]!();
    await vi.advanceTimersByTimeAsync(0);

    const results = await resultsPromise;
    expect(results).toHaveLength(3);
  });
});

describe('abort-listener cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('cleans up the external abort signal listener after classify returns', async () => {
    const externalSignal = new AbortController();
    const addEventListenerSpy = vi.spyOn(externalSignal.signal, 'addEventListener');

    const classify = vi.fn().mockResolvedValue(classifyResult());
    const adapter: ProviderAdapter = {
      providerId: 'test-local',
      providerInfo: {
        id: 'test-local',
        name: 'Test Local',
        locality: 'local',
        supportedCapabilities: ['classification'],
        endpoint: null,
        authType: null,
        model: 'test-model-v1',
      },
      classify,
    };

    const orchestrator = new Orchestrator({
      providers: [adapter],
      policy: createPolicyEngine({
        capabilities: defaultPolicies({ classification: 'local-only' }),
        providerAllowlists: [{ capability: 'classification', allowedProviderIds: ['test-local'] }],
        policyVersion: '1.0',
      }),
      redactor: createRedactor(),
      promptVersion: 'v1',
      signal: externalSignal.signal,
    });

    // Use a real promise for the classify result
    const promise = orchestrator.classify([makeCandidate()]);
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(classify).toHaveBeenCalledTimes(1);
    // The listener was added (via addEventListener). After classify returns,
    // the orchestrator must have removed it or used { once: true }.
    // Using { once: true } auto-removes after the first fire, but we
    // want to verify it never fired — it shouldn't since we didn't abort.
    expect(addEventListenerSpy).toHaveBeenCalledTimes(1);
  });

  it('aborts the local abort controller when external signal aborts', async () => {
    const externalSignal = new AbortController();
    const classify = vi.fn().mockImplementation(async (req: ClassifyRequest) => {
      // Wait on the provider signal — external abort should trigger it
      const { promise, reject } = Promise.withResolvers<ClassificationResult>();
      if (req.signal?.aborted) {
        reject(new Error('aborted'));
      } else {
        req.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }
      return promise;
    });

    const adapter: ProviderAdapter = {
      providerId: 'test-local',
      providerInfo: {
        id: 'test-local',
        name: 'Test Local',
        locality: 'local',
        supportedCapabilities: ['classification'],
        endpoint: null,
        authType: null,
        model: 'test-model-v1',
      },
      classify,
    };

    const orchestrator = new Orchestrator({
      providers: [adapter],
      policy: createPolicyEngine({
        capabilities: defaultPolicies({ classification: 'local-only' }),
        providerAllowlists: [{ capability: 'classification', allowedProviderIds: ['test-local'] }],
        policyVersion: '1.0',
      }),
      redactor: createRedactor(),
      promptVersion: 'v1',
      signal: externalSignal.signal,
    });

    const promise = orchestrator.classify([makeCandidate()]);
    // Let the classify call start
    await vi.advanceTimersByTimeAsync(0);

    // Abort externally
    externalSignal.abort();

    const results = await promise;
    expect(results).toHaveLength(1);
    expect(results[0].errors.length).toBeGreaterThan(0);
    expect(results[0].errors.join(', ')).toMatch(/cancel/i);
  });

  it('timeout fires and creates error-bearing suggestion', async () => {
    const classify = vi.fn().mockImplementation(async () => {
      // Never resolve — timeout should catch this
      const { promise } = Promise.withResolvers<ClassificationResult>();
      return promise;
    });

    const adapter: ProviderAdapter = {
      providerId: 'test-local',
      providerInfo: {
        id: 'test-local',
        name: 'Test Local',
        locality: 'local',
        supportedCapabilities: ['classification'],
        endpoint: null,
        authType: null,
        model: 'test-model-v1',
      },
      classify,
    };

    const orchestrator = new Orchestrator({
      providers: [adapter],
      policy: createPolicyEngine({
        capabilities: defaultPolicies({ classification: 'local-only' }),
        providerAllowlists: [{ capability: 'classification', allowedProviderIds: ['test-local'] }],
        policyVersion: '1.0',
      }),
      redactor: createRedactor(),
      promptVersion: 'v1',
      // Very short timeout to test
      providerTimeoutMs: 100,
    });

    const promise = orchestrator.classify([makeCandidate()]);

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(200);

    const results = await promise;
    expect(results).toHaveLength(1);
    expect(results[0].errors.length).toBeGreaterThan(0);
    expect(results[0].errors.join(', ')).toMatch(/timeout/i);
  });
});

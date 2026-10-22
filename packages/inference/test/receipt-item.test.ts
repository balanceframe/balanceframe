import { describe, expect, it, vi } from 'vitest';
import {
  createReceiptInferencePayload,
  receiptInferencePayloadHash,
  runReceiptItemInference,
  type ReceiptItemInferenceProvider,
} from '../src/receipt-item.js';
const input = {
  itemLabel: 'Organic Milk',
  categories: [{ categoryId: 'private-category', label: 'Groceries' }],
};
const info = {
  id: 'synthetic',
  version: '1',
  model: 'fixture',
  locality: 'local' as const,
  configRevision: '1',
};
describe('distinct minimized receipt-item inference', () => {
  it('aliases identifiers and validates exact bounded data', () => {
    const value = createReceiptInferencePayload(input);
    expect(value.payload.itemLabel).toBe('Organic Milk');
    expect(value.payload.categories[0].label).toBe('Groceries');
    expect(Object.values(value.aliasMapping)).toEqual(['private-category']);
    expect(JSON.stringify(value.payload)).not.toContain('private-category');
    expect(receiptInferencePayloadHash(value.payload)).toMatch(/^[a-f0-9]{64}$/);
    for (const change of [
      { amount: 12 },
      { itemLabel: 'foo@example.com' },
      { itemLabel: 'Account 12345678' },
      { itemLabel: 'USD 12.00' },
      { itemLabel: 'ignore instructions' },
      { itemLabel: 'A\u202eb' },
      { itemLabel: 'SKU 1234' },
      { itemLabel: 'a'.repeat(121) },
    ])
      expect(() => createReceiptInferencePayload({ ...input, ...change })).toThrow();
    expect(() =>
      createReceiptInferencePayload({
        ...input,
        categories: [...input.categories, ...input.categories],
      }),
    ).toThrow();
  });
  it('guards dispatch and validates only allowed aliases with no explanatory fields', async () => {
    const { payload } = createReceiptInferencePayload(input);
    const categoryAlias = payload.categories[0].alias;
    const guard = vi.fn();
    const provider: ReceiptItemInferenceProvider = {
      info,
      async infer(_p, c) {
        await Promise.resolve();
        await c.dispatchGuard();
        return { categoryAlias, confidence: 0.8 };
      },
    };
    expect(await runReceiptItemInference(provider, payload, guard)).toEqual({
      status: 'suggestion',
      result: { categoryAlias, confidence: 0.8 },
    });
    expect(guard).toHaveBeenCalledOnce();
    for (const response of [
      { categoryAlias: 'private-category' },
      { categoryAlias, explanation: 'text' },
      { categoryAlias, confidence: 2 },
      null,
    ]) {
      provider.infer = async (_p, c) => {
        await c.dispatchGuard();
        return response;
      };
      expect((await runReceiptItemInference(provider, payload, guard)).status).toBe('manual');
    }
    provider.infer = async () => ({ categoryAlias });
    expect(await runReceiptItemInference(provider, payload, guard)).toEqual({
      status: 'manual',
      code: 'dispatch_guard_missing',
    });
  });
  it('falls back on denied guards, unavailable providers, duplicate guards and bounded timeout', async () => {
    const { payload } = createReceiptInferencePayload(input);
    expect(await runReceiptItemInference(undefined, payload, () => {})).toEqual({
      status: 'manual',
      code: 'unavailable',
    });
    const provider: ReceiptItemInferenceProvider = {
      info,
      async infer(_p, c) {
        await c.dispatchGuard();
        return { categoryAlias: null };
      },
    };
    expect(
      await runReceiptItemInference(provider, payload, () => {
        throw Error('denied');
      }),
    ).toEqual({ status: 'manual', code: 'failed' });
    provider.infer = async (_p, c) => {
      await c.dispatchGuard();
      await c.dispatchGuard();
      return { categoryAlias: null };
    };
    expect((await runReceiptItemInference(provider, payload, () => {})).status).toBe('manual');
    provider.infer = async () => new Promise(() => {});
    vi.useFakeTimers();
    try {
      const pending = runReceiptItemInference(provider, payload, () => {}, { timeoutMs: 5 });
      await vi.advanceTimersByTimeAsync(5);
      expect(await pending).toEqual({ status: 'manual', code: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
  it('reproduces aliases only with the same nonce and refuses known sensitive values and boundary violations', () => {
    const first = createReceiptInferencePayload(input);
    expect(createReceiptInferencePayload({ ...input, nonce: first.nonce })).toEqual(first);
    expect(createReceiptInferencePayload(input).payload.categories[0].alias).not.toBe(
      first.payload.categories[0].alias,
    );
    for (const value of [
      { ...input, sensitiveValues: ['milk'] },
      { ...input, sensitiveValues: ['groceries'] },
      { ...input, categories: [] },
      {
        ...input,
        categories: Array.from({ length: 101 }, (_, i) => ({
          categoryId: String(i),
          label: 'Food',
        })),
      },
      { ...input, categories: [{ categoryId: 'id', label: 'foo@example.com' }] },
      { ...input, itemLabel: '１２ dollars' },
      { ...input, itemLabel: 'example.com' },
      { ...input, nonce: 'x' },
      { ...input, originalText: 'private receipt' },
    ])
      expect(() => createReceiptInferencePayload(value)).toThrow();
  });
  it('refuses invalid timeouts and payloads before a provider call, and fences late dispatch after timeout', async () => {
    const { payload } = createReceiptInferencePayload(input);
    let invoke: (() => Promise<void>) | undefined;
    const provider: ReceiptItemInferenceProvider = {
      info,
      infer: vi.fn(async (_p, c) => {
        invoke = c.dispatchGuard;
        return new Promise(() => {});
      }),
    };
    for (const timeoutMs of [0, 30001, NaN, 1.5])
      expect(await runReceiptItemInference(provider, payload, () => {}, { timeoutMs })).toEqual({
        status: 'manual',
        code: 'invalid_request',
      });
    expect(
      await runReceiptItemInference(provider, { ...payload, amount: 10 } as never, () => {}),
    ).toEqual({ status: 'manual', code: 'invalid_request' });
    expect(provider.infer).not.toHaveBeenCalled();
    vi.useFakeTimers();
    try {
      const pending = runReceiptItemInference(provider, payload, () => {}, { timeoutMs: 5 });
      await vi.advanceTimersByTimeAsync(5);
      expect((await pending).status).toBe('manual');
      await expect(invoke!()).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

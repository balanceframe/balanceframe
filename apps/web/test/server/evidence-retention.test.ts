// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ sweep: vi.fn(), store: vi.fn() }));
vi.mock('../../server/utils/workflow-store', () => ({ getWorkflowStore: deps.store }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-10-21T12:00:00.000Z');
  vi.stubGlobal('defineNitroPlugin', (handler: unknown) => handler);
  vi.stubGlobal('useRuntimeConfig', () => ({}));
  deps.store.mockReturnValue({ store: { evidence: { expireRaw: deps.sweep } } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('raw evidence retention housekeeping', () => {
  it('purges deadlines on startup and periodically, stops with the owned app lifecycle', async () => {
    const plugin = (await import('../../server/plugins/evidence-retention')).default;
    const close = vi.fn();
    const hook = vi.fn((_name: string, callback: () => void) => close.mockImplementation(callback));
    await plugin({ hooks: { hook } } as unknown as Parameters<typeof plugin>[0]);
    expect(deps.sweep).toHaveBeenCalledWith('2026-10-21T12:00:00.000Z');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.sweep).toHaveBeenCalledTimes(2);
    close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deps.sweep).toHaveBeenCalledTimes(2);
  });
});

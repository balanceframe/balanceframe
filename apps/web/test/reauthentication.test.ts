import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reauthenticateHuman } from '../app/utils/reauthentication';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode: false } }));
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const demoState = {
  status: 'ready', shared: true, generation: 7, personaId: 'coapprover', csrfToken: 'signed-demo-csrf',
};

describe('explicit human reauthentication transport', () => {
  it('keeps ordinary Source password confirmation on its real password endpoint', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'success' })));
    await reauthenticateHuman('ordinary-current-password');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/reauth', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', body: JSON.stringify({ password: 'ordinary-current-password' }),
    }));
  });

  it('requires explicit CONFIRM in demo mode and never submits arbitrary text as a fixture password', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode: true } }));
    await expect(reauthenticateHuman('not-a-demo-confirmation')).rejects.toThrow(/CONFIRM/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renews the current signed demo persona through generation and CSRF without a browser password', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode: true } }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(demoState)));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ generation: 7, reauthenticated: true })));
    await reauthenticateHuman('CONFIRM');
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/__demo/state', '/__demo/reauth']);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-BalanceFrame-Demo-CSRF': 'signed-demo-csrf' },
      body: JSON.stringify({ expectedGeneration: 7 }),
    }));
    expect(fetchMock.mock.calls[1]?.[1]?.body).not.toContain('password');
  });

  it('rejects a failed or stale demo renewal instead of treating it as a usable proof', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode: true } }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(demoState)));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'DEMO_STALE_GENERATION' } }), { status: 409 }));
    await expect(reauthenticateHuman('CONFIRM')).rejects.toThrow(/DEMO_STALE_GENERATION/);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/__demo/state', '/__demo/reauth']);
  });
});

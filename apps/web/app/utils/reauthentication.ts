import { z } from 'zod';

const DemoState = z.object({
  status: z.literal('ready'),
  shared: z.literal(true),
  generation: z.number().int().safe().positive(),
  personaId: z.string().min(1),
  csrfToken: z.string().min(1),
});
const DemoProof = z.object({
  generation: z.number().int().safe().positive(),
  reauthenticated: z.literal(true),
});

/** Obtains fresh Source password proof, or explicit signed disposable-demo persona confirmation. */
export async function reauthenticateHuman(password: string): Promise<void> {
  const demoMode = typeof useRuntimeConfig === 'function' && useRuntimeConfig().public.demoMode === true;
  let demoGeneration: number | null = null;
  let response: Response;
  if (demoMode) {
    if (password !== 'CONFIRM') throw new Error('Type CONFIRM for disposable-demo confirmation, not your account password.');
    const stateResponse = await fetch('/__demo/state', { credentials: 'same-origin' });
    const value: unknown = await stateResponse.json().catch(() => null);
    const parsed = DemoState.safeParse(value);
    if (!stateResponse.ok || !parsed.success)
      throw new Error('Disposable-demo confirmation unavailable. Open the current demo controls.');
    const state = parsed.data;
    demoGeneration = state.generation;
    response = await fetch('/__demo/reauth', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-BalanceFrame-Demo-CSRF': state.csrfToken },
      body: JSON.stringify({ expectedGeneration: demoGeneration }),
    });
  } else {
    response = await fetch('/api/reauth', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  }
  const value: unknown = await response.json().catch(() => null);
  const body =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as {
          status?: unknown;
          error?: { code?: unknown; message?: unknown } | null;
        })
      : null;
  const proof = demoMode ? DemoProof.safeParse(value) : null;

  if (!response.ok || (demoMode
    ? !proof?.success || proof.data.generation !== demoGeneration
    : body?.status !== 'success')) {
    const message =
      typeof body?.error?.message === 'string'
        ? body.error.message
        : `Password confirmation failed (HTTP ${response.status}).`;
    const code = typeof body?.error?.code === 'string' ? body.error.code : null;
    throw new Error(code ? `${code}: ${message}` : message);
  }
}

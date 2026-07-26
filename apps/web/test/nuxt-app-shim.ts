/**
 * Test shim for Nuxt's `#app` virtual module.
 *
 * Vitest resolves `#app` to this file so that modules importing from `#app`
 * (e.g. route middleware) can be loaded outside the Nuxt build pipeline.
 *
 * Tests that rely on `#app` exports are expected to mock them with
 * `vi.mock('#app', …)` — the real exports here are safe defaults so that
 * importing the module doesn't crash even when no mock is active.
 */

/**
 * Pass-through wrapper for Nuxt route middleware handlers.
 */
export function defineNuxtRouteMiddleware<T>(handler: T): T {
  return handler;
}

/**
 * Returns request headers (stub — returns empty object in test context).
 */
export function useRequestHeaders(): Record<string, string | undefined> {
  return {};
}

/**
 * Navigation stub — tests that exercise navigation should mock this.
 */
export function navigateTo(_location: unknown): void {
  /* stub — tests mock this via vi.mock('#app') */
}

/**
 * Vitest setup — stubs Nuxt and Vue auto-imports so page components
 * (which use <script setup> with Nuxt auto-imports) can be mounted
 * with @vue/test-utils outside the Nuxt build pipeline.
 */
import { ref, computed, onMounted, nextTick, watch, shallowRef } from 'vue';
import { vi, beforeEach } from 'vitest';

vi.stubGlobal('ref', ref);
vi.stubGlobal('computed', computed);
vi.stubGlobal('onMounted', onMounted);
vi.stubGlobal('nextTick', nextTick);
vi.stubGlobal('watch', watch);
vi.stubGlobal('shallowRef', shallowRef);
vi.stubGlobal('navigateTo', vi.fn());
vi.stubGlobal('definePageMeta', vi.fn(() => {}));
vi.stubGlobal('$fetch', vi.fn());

// Nuxt server auto-imports used by api handlers (not imported from h3).
vi.stubGlobal('defineEventHandler', (handler: unknown) => handler);
vi.stubGlobal('getQuery', vi.fn(() => ({})));
vi.stubGlobal('setResponseStatus', vi.fn());
vi.stubGlobal('readBody', vi.fn(async () => ({})));

beforeEach(() => {
  vi.clearAllMocks();
});

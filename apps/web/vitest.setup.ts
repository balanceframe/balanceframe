/**
 * Vitest setup — stubs Nuxt and Vue auto-imports so page components
 * (which use <script setup> with Nuxt auto-imports) can be mounted
 * with @vue/test-utils outside the Nuxt build pipeline.
 */

import { ref, computed, onMounted, nextTick, watch, shallowRef } from 'vue';
import { vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Vue reactivity auto-imports (provided by Nuxt via unplugin-auto-import)
// ---------------------------------------------------------------------------

vi.stubGlobal('ref', ref);
vi.stubGlobal('computed', computed);
vi.stubGlobal('onMounted', onMounted);
vi.stubGlobal('nextTick', nextTick);
vi.stubGlobal('watch', watch);
vi.stubGlobal('shallowRef', shallowRef);

// ---------------------------------------------------------------------------
// Nuxt auto-imports
// ---------------------------------------------------------------------------

vi.stubGlobal('navigateTo', vi.fn());
vi.stubGlobal('definePageMeta', vi.fn(() => {}));
vi.stubGlobal('$fetch', vi.fn());

// ---------------------------------------------------------------------------
// Clean up between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

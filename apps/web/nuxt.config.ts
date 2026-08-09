// https://nuxt.com/docs/api/configuration/nuxt-config
import { createRequire } from 'node:module';

const actualApiEntry = createRequire(import.meta.url).resolve('@actual-app/api');

export default defineNuxtConfig({
  srcDir: 'app/',
  ssr: false,
  modules: ['@nuxt/ui'],
  compatibilityDate: '2026-07-20',

  app: {
    head: {
      title: 'BalanceFrame — Transaction Review',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    },
  },

  ui: {/** Nuxt UI v4 global theme overrides — no-op until customised. */},

  runtimeConfig: {
    /** API Bearer token for operational routes (legacy migration fallback). */
    apiToken: undefined,

    /** Explicitly allow unauthenticated requests during local development. */
    devBypassAuth: false,

    /** Actor identity for authenticated requests. */
    authActorId: 'api-user',

    /** Enable write mutations on approve/correct (default: observe-only). */
    reviewAndApply: false,

    /** Path to the workflow SQLite database. */
    workflowDbPath: '',

    /** Path to the Better Auth SQLite database. */
    authDbPath: '',

    /** Path or indicator that a bootstrap secret is configured (set by env). */
    bootstrapSecretPath: '',

    public: {
      apiBase: '',
    },
  },

  nitro: {
    preset: 'node-server',
    // Rollup evaluates `external` before Nitro's node-externals plugin. Keep
    // Actual's CommonJS filesystem code in its package context. `traceInclude`
    // is an input path for node-file-trace, so resolve the direct production
    // dependency instead of passing its package specifier.
    externals: {
      external: ['better-sqlite3'],
      traceInclude: [actualApiEntry],
    },
    rollupConfig: {
      external: (id) => id === '@actual-app/api' || id.startsWith('@actual-app/api/'),
    },
  },
});

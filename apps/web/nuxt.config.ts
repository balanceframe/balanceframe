// https://nuxt.com/docs/api/configuration/nuxt-config
import { createRequire } from 'node:module';

const actualApiEntry = createRequire(import.meta.url).resolve('@actual-app/api');

export default defineNuxtConfig({
  srcDir: 'app/',
  ssr: false,
  modules: ['@nuxt/ui'],
  compatibilityDate: '2026-07-20',

  // Login/setup icons are public static data, not protected operational API data.
  icon: {
    provider: 'server',
    localApiEndpoint: '/_nuxt_icon',
    fallbackToApi: false,
  },

  vite: {
    build: {
      rolldownOptions: {
        // Disable only the callback/link-time heuristic, not build diagnostics.
        checks: { bundlerTimings: false },
      },
    },
  },

  app: {
    head: {
      title: 'BalanceFrame — Transaction Review',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    },
  },

  // The system font stack does not need remote font-catalog discovery.
  ui: { fonts: false },

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

    /** Path to the runner-owned BalanceFrame connection configuration. */
    connectionPath: '',

    /** Runner-owned private demo manifest; absence leaves normal behavior unchanged. */
    demoManifestPath: '',

    /** Runner-owned Actual endpoint used by the demo boundary. */
    actualServerUrl: '',

    /** Runner-owned credential directory used by the demo child. */
    credentialDir: '',

    /** Path or indicator that a bootstrap secret is configured (set by env). */
    bootstrapSecretPath: '',

    public: {
      apiBase: '',
      /** Presentation flag only; server authorization uses the private manifest. */
      demoMode: false,
    },
  },

  nitro: {
    preset: 'node-server',
    // Match the production runtime instead of Nitro's legacy es2019 default.
    esbuild: { options: { target: 'node22' } },
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

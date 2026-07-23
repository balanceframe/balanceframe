// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  srcDir: 'app/',
  ssr: false,
  modules: ['@nuxt/ui'],
  compatibilityDate: '2026-07-20',

  app: {
    head: {
      title: 'BalanceFrame — Transaction Review',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
    },
  },

  ui: {
    /** Nuxt UI v4 global theme overrides — no-op until customised. */
  },


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

    public: {
      apiBase: '',
    },
  },

  nitro: {
    preset: 'node-server',
    externals: {
      // better-sqlite3 is a native addon — must not be bundled.
      external: ['better-sqlite3'],
    },
  },
});

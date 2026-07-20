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

  nitro: {
    /** Authenticated query/command endpoints only. */
    preset: 'node-server',
  },

  runtimeConfig: {
    /**
     * API Bearer token for operational routes.
     * No default — production fails closed if unset.
     * Override via `NUXT_API_TOKEN` env var or `BALANCEFRAME_API_TOKEN`.
     */
    apiToken: undefined,

    /**
     * Explicitly allow unauthenticated requests during local development.
     * Never enable in production contexts.
     * Override via `NUXT_DEV_BYPASS_AUTH` env var.
     */
    devBypassAuth: false,

    /**
     * Actor identity to embed in the auth context for authenticated requests.
     * Override via `NUXT_AUTH_ACTOR_ID` env var.
     */
    authActorId: 'api-user',

    /** Path to the workflow SQLite database. */
    workflowDbPath: '',

    public: {
      apiBase: '',
    },
  },
});

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
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
});

/** Reports whether Better Auth has an explicit secret using lib/auth's configuration precedence. */
export function isBetterAuthConfigured(): boolean {
  return !!(process.env.BETTER_AUTH_SECRET || process.env.NUXT_BETTER_AUTH_SECRET);
}

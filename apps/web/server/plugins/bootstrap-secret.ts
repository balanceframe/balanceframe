/**
 * Nitro server plugin that validates bootstrap-secret configuration at startup.
 *
 * Calls validateBootstrapSecretConfig() during server initialisation to ensure
 * that if a bootstrap secret source is configured, it is syntactically valid
 * (exactly one source, file readable, secret at least 32 characters).
 *
 * Configuration errors cause the server to fail closed — the plugin throws
 * synchronously, preventing the server from accepting requests with a broken
 * bootstrap-secret setup. A missing source (neither env var) is tolerated
 * because the instance may already be bootstrapped.
 */

import { validateBootstrapSecretConfig } from '../../lib/resolve-bootstrap-secret';

export default defineNitroPlugin(() => {
  validateBootstrapSecretConfig();
  console.log('[bootstrap-secret] Configuration validated');
});

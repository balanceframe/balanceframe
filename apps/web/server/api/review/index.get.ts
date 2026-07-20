/**
 * GET /api/review — list pending review items.
 *
 * Returns a JSON envelope with an empty items array (pending review
 * data not yet wired to the workflow store).
 */
export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  const auth = event.context.auth as { authenticated: boolean } | undefined;

  return {
    schemaVersion: '1',
    requestId,
    status: 'ok',
    dataFreshness: null,
    authorization: auth
      ? { actorId: 'web-user', capability: 'observe', allowed: true }
      : null,
    result: {
      items: [],
      total: 0,
    },
    error: null,
  };
});

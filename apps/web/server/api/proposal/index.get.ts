/**
 * GET /api/proposal — list proposals.
 *
 * Returns a JSON envelope with an empty proposals array.
 * Schema follows the application layer's ProposalListResult type:
 *   { proposals: ProposalListItem[], total: number }
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
      proposals: [],
      total: 0,
    },
    error: null,
  };
});

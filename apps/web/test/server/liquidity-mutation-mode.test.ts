import { describe, expect, it } from 'vitest';
import type { H3Event } from 'h3';
import { liquidityRoute } from '../../server/utils/liquidity-service';

describe('spend-session completion HTTP mutation boundary', () => {
  it('rejects a ledger write in observe-only mode before calling the operation', async () => {
    let called = false;
    const route = liquidityRoute(async () => {
      called = true;
      return { written: true };
    }, false, true);
    const event = {
      context: { auth: { authenticated: true }, runtimeConfig: { reviewAndApply: false } },
      node: { req: { url: '/api/spend-sessions/id/completions/id/execute', headers: {} }, res: { statusCode: 200 } },
    } as unknown as H3Event;

    const response = await route(event);
    expect(response).toMatchObject({ status: 'error', error: { code: 'MUTATION_MODE_DISABLED' } });
    expect(event.node.res.statusCode).toBe(403);
    expect(called).toBe(false);
  });
});

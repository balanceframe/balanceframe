// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { H3Event } from 'h3';

const deps = vi.hoisted(() => ({
  selected: vi.fn(),
  authorize: vi.fn(),
  actor: vi.fn(),
  service: vi.fn(),
  key: vi.fn(),
  store: vi.fn(),
  operation: vi.fn(),
}));
vi.mock('../../server/utils/space-context', () => ({ requireSelectedSpace: deps.selected }));
vi.mock('../../server/utils/workflow-store', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  requireAuthorization: deps.authorize,
  getWorkflowStore: deps.store,
}));
vi.mock('../../server/utils/liquidity-service', () => ({ selectedLiquidityActor: deps.actor }));
vi.mock('../../server/utils/evidence-key', () => ({ loadEvidenceEncryptionKey: deps.key }));
vi.mock('@balanceframe/application', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createTransactionEvidenceService: deps.service,
}));
import { evidenceRoute } from '../../server/utils/transaction-evidence';
import { BoundedJsonBodyError } from '../../server/utils/bounded-json';

function event(query: Record<string, string> = {}, origin = 'https://balanceframe.test'): H3Event {
  const path =
    '/api/evidence' + (Object.keys(query).length ? `?${new URLSearchParams(query)}` : '');
  return {
    path,
    context: {},
    node: {
      req: { url: path, headers: { origin } },
      res: { setHeader: vi.fn(), getHeader: vi.fn(), statusCode: 200 },
    },
  } as unknown as H3Event;
}
beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_URL', 'https://balanceframe.test');
  deps.selected.mockReturnValue({
    ok: true,
    space: { id: 'space', budgetId: 'budget' },
    membership: { id: 'membership' },
    auth: { method: 'session', actorId: 'actor', sessionId: 'session' },
  });
  deps.authorize.mockResolvedValue({
    ok: true,
    info: { actorId: 'actor', capability: 'observe', allowed: true },
  });
  deps.actor.mockReturnValue({
    actorId: 'actor',
    spaceId: 'space',
    budgetId: 'budget',
    auth: { method: 'session', actorId: 'actor', sessionId: 'session' },
  });
  deps.store.mockReturnValue({ store: {} });
  deps.key.mockReturnValue(Buffer.alloc(32));
  deps.service.mockResolvedValue({ list: vi.fn() });
  deps.operation.mockResolvedValue({ documents: [] });
});
afterEach(() => vi.unstubAllEnvs());
describe('selected-space transaction evidence routes', () => {
  it.each([400, 413] as const)(
    'publishes only the safe %i request-boundary error after authorization',
    async (status) => {
      deps.operation.mockRejectedValueOnce(new BoundedJsonBodyError(status));
      const request = event();
      const result = await evidenceRoute(deps.operation, { write: true, capability: 'ingest' })(
        request,
      );
      expect(request.node.res.statusCode).toBe(status);
      expect(result.status).toBe('error');
      expect(JSON.stringify(result)).not.toContain('stack');
    },
  );
  it('does not create a service or read the key when selected membership is unavailable', async () => {
    deps.selected.mockReturnValue({
      ok: false,
      response: { status: 'error', error: { code: 'FORBIDDEN' } },
    });
    const result = await evidenceRoute(deps.operation)(event());
    expect(result.status).toBe('error');
    expect(deps.service).not.toHaveBeenCalled();
    expect(deps.key).not.toHaveBeenCalled();
  });
  it('requires authorization before reading key material or constructing connectors', async () => {
    deps.authorize.mockResolvedValue({
      ok: false,
      response: { status: 'error', error: { code: 'FORBIDDEN' } },
    });
    expect((await evidenceRoute(deps.operation)(event())).status).toBe('error');
    expect(deps.key).not.toHaveBeenCalled();
    expect(deps.operation).not.toHaveBeenCalled();
  });
  it('refuses query authority and foreign write origins before invoking the service', async () => {
    expect((await evidenceRoute(deps.operation)(event({ actorId: 'forged' }))).status).toBe(
      'error',
    );
    expect(
      (await evidenceRoute(deps.operation, { write: true })(event({}, 'https://foreign.test')))
        .status,
    ).toBe('error');
    expect(deps.operation).not.toHaveBeenCalled();
  });
  it('returns no-store data from server-selected identity and hides raw connector failures', async () => {
    const request = event();
    const route = evidenceRoute(deps.operation);
    const result = await route(request);
    expect(result.status).toBe('ok');
    expect(deps.operation).toHaveBeenCalledWith(
      request,
      expect.anything(),
      expect.objectContaining({ actorId: 'actor', budgetId: 'budget', spaceId: 'space' }),
    );
    expect(request.node.res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    deps.operation.mockRejectedValue(new Error('PRIVATE_MAILBOX_NOTE_AND_SERVER_PASSWORD'));
    const failed = await route(event());
    expect(failed.status).toBe('error');
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_MAILBOX');
  });
});

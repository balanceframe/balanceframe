import { beforeEach, describe, expect, it, vi } from 'vitest';
const { authorize, evaluate, status, factory } = vi.hoisted(() => ({
  authorize: vi.fn(),
  evaluate: vi.fn(),
  status: vi.fn(),
  factory: vi.fn(),
}));
vi.mock('@balanceframe/application', async (importOriginal) => ({
  ...(await importOriginal()),
  createDefaultConnectionManager: () => ({ loadConfig: async () => ({ budgetId: 'budget' }) }),
  createLiquidityService: factory,
}));
vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  getQuery: (event: { query?: unknown }) => event.query ?? {},
  setResponseStatus: status,
}));
vi.mock('../../server/utils/workflow-store', () => ({
  requireAuthorization: authorize,
  getActorId: () => 'reader',
  getWorkflowStore: () => ({ store: {} }),
  okEnvelope: (result: unknown) => ({ status: 'ok', result }),
  errorEnvelope: (code: string, message: string) => ({ status: 'error', error: { code, message } }),
}));
import handler from '../../server/api/purchase/evaluate.get';

describe('existing purchase endpoint account-aware trust boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorize.mockResolvedValue({
      ok: true,
      info: { actorId: 'reader', capability: 'observe', allowed: true },
    });
    factory.mockResolvedValue({ evaluatePurchase: evaluate });
  });
  it('denies unauthenticated access before composing the financial service', async () => {
    authorize.mockResolvedValue({
      ok: false,
      response: { status: 'error', error: { code: 'AUTHORIZATION_REQUIRED' } },
    });
    const response = await handler({ query: { categoryId: 'food', amount: '2000' }, context: {} });
    expect(response.status).toBe('error');
    expect(factory).not.toHaveBeenCalled();
  });
  it('rejects caller financial context before executing a purchase evaluation', async () => {
    const response = await handler({
      query: { categoryId: 'food', amount: '2000', context: { actorId: 'owner' } },
      context: { auth: { authenticated: true, actorId: 'reader' } },
    });
    expect(response.status).toBe('error');
    expect(status).toHaveBeenCalledWith(expect.anything(), 400);
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('does not expose private source details from a failed evaluation', async () => {
    evaluate.mockRejectedValue(
      new Error('Private savings source insufficient: account-private, 900000 USD'),
    );
    const response = await handler({
      query: { categoryId: 'food', amount: '2000' },
      context: { auth: { authenticated: true, actorId: 'reader' } },
    });
    expect(response.status).toBe('error');
    expect(status).toHaveBeenCalledWith(expect.anything(), 409);
    expect(JSON.stringify(response)).not.toMatch(/Private savings|account-private|900000/);
  });
  it('accepts a current selected-budget member without requiring wildcard observation authority', async () => {
    authorize.mockImplementation(async (_event, _capability, scope) =>
      scope === 'budget:budget'
        ? { ok: true, info: { actorId: 'reader', capability: 'observe', allowed: true } }
        : { ok: false, response: { status: 'error', error: { code: 'FORBIDDEN' } } },
    );
    evaluate.mockResolvedValue({ allowable: false });
    expect(
      (
        await handler({
          query: { categoryId: 'food', amount: '2000' },
          context: { auth: { authenticated: true, actorId: 'reader' } },
        })
      ).status,
    ).toBe('ok');
  });
});

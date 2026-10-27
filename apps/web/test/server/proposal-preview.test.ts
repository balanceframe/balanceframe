// @vitest-environment node
// Genuine HTTP handler boundary; source/governance behavior is covered by service and SDK tests.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp, defineEventHandler, setResponseStatus, toNodeListener } from 'h3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  preview: vi.fn(),
  native: vi.fn(),
  manager: vi.fn(),
  selected: true,
  changed: false,
  agent: false,
  store: {},
}));
vi.mock('@balanceframe/application', () => ({
  CategorizationPreviewService: class {
    preview = deps.preview;
  },
  CategorizationPreviewError: class extends Error {
    code = 'CATEGORIZATION_PREVIEW_UNAVAILABLE';
    constructor(
      readonly reasonCode: string,
      readonly statusCode: 403 | 404,
    ) {
      super('Private preview withheld');
    }
  },
  createDefaultConnectionManager: deps.manager,
  createNativeCategorizationMutationProtocol: deps.native,
}));
vi.mock('../../server/utils/workflow-store', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getWorkflowStore: () => ({ store: deps.store }),
}));
vi.mock('../../server/utils/space-context', () => ({
  requireSelectedSpace: (event: Parameters<typeof setResponseStatus>[0]) => {
    if (!deps.selected) {
      setResponseStatus(event, 403);
      return {
        ok: false,
        response: { status: 'error', result: null, error: { code: 'FORBIDDEN' } },
      };
    }
    return {
      ok: true,
      space: { id: 'space', budgetId: deps.changed ? 'other' : 'budget' },
      auth: deps.agent
        ? { method: 'api-key', actorId: 'agent', principalType: 'agent' }
        : { method: 'session', actorId: 'human', sessionId: 'session' },
    };
  },
}));
import previewRoute from '../../server/api/proposal/[id]/preview.post';
import { CategorizationPreviewError } from '@balanceframe/application';

const report = {
  simulationOnly: true,
  proposalId: 'proposal',
  payloadHash: 'a'.repeat(64),
  status: 'eligible_on_captured_inputs',
  reasonCodes: [],
  plan: { transactionId: 'tx', proposedCategoryId: 'category' },
  source: { kind: 'locally_observed', atomic: false, serverConfirmed: false, maySynchronize: true },
};
const servers: ReturnType<typeof createServer>[] = [];
beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_URL', 'https://balanceframe.example.test');
  vi.clearAllMocks();
  deps.selected = true;
  deps.changed = false;
  deps.agent = false;
  deps.preview.mockResolvedValue(report);
  deps.native.mockResolvedValue({});
  deps.manager.mockReturnValue({});
});
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  vi.unstubAllEnvs();
});
async function request(origin = 'https://balanceframe.example.test', id = 'proposal') {
  const app = createApp();
  app.use(
    defineEventHandler((event) => {
      event.context.params = { id };
      return previewRoute(event);
    }),
  );
  const server = createServer(toNodeListener(app));
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/proposal/${encodeURIComponent(id)}/preview`,
    {
      method: 'POST',
      headers: { origin },
    },
  );
  return { response, body: await response.json() };
}
describe('categorization preview HTTP boundary', () => {
  it('uses only the server selected human/budget and publishes a private preview without execution', async () => {
    const { response, body } = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(body.result).toEqual(report);
    expect(deps.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'human',
        spaceId: 'space',
        budgetId: 'budget',
        proposalId: 'proposal',
        auth: { method: 'session', actorId: 'human', sessionId: 'session' },
      }),
    );
    expect(deps.preview).toHaveBeenCalledTimes(1);
  });
  it.each(['foreign-origin', 'no-selection', 'agent', 'invalid-id'] as const)(
    'rejects %s before composing a source',
    async (kind) => {
      if (kind === 'no-selection') deps.selected = false;
      if (kind === 'agent') deps.agent = true;
      const { response, body } = await request(
        kind === 'foreign-origin' ? 'https://untrusted.example.test' : undefined,
        kind === 'invalid-id' ? ' '.repeat(3) : undefined,
      );
      expect(response.status).toBe(kind === 'invalid-id' ? 400 : 403);
      expect(body.result).toBeNull();
      expect(deps.manager).not.toHaveBeenCalled();
      expect(deps.native).not.toHaveBeenCalled();
      expect(deps.preview).not.toHaveBeenCalled();
    },
  );
  it.each(['revocation', 'budget-change'] as const)(
    'withholds a completed private result after %s',
    async (kind) => {
      deps.preview.mockImplementation(async () => {
        if (kind === 'revocation') deps.selected = false;
        else deps.changed = true;
        return report;
      });
      const { response, body } = await request();
      expect(response.status).toBe(kind === 'revocation' ? 403 : 409);
      expect(body.result).toBeNull();
      expect(JSON.stringify(body)).not.toContain('proposedCategoryId');
    },
  );
  it('withholds authorization failures without exposing internal reasons', async () => {
    deps.preview.mockRejectedValue(new CategorizationPreviewError('secret authority detail', 403));
    const { response, body } = await request();
    expect(response.status).toBe(403);
    expect(body.error.code).toBe('CATEGORIZATION_PREVIEW_UNAVAILABLE');
    expect(body.error.message).toContain('may have synchronized');
    expect(body.result).toBeNull();
    expect(JSON.stringify(body)).not.toContain('secret');
  });
  it('sanitizes unexpected source errors', async () => {
    deps.preview.mockRejectedValue(new Error('secret credentials'));
    const { response, body } = await request();
    expect(response.status).toBe(503);
    expect(body.result).toBeNull();
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(body.error.message).toContain('may have synchronized');
  });
});

import { beforeEach, expect, it, vi } from 'vitest';
import type { H3Event } from 'h3';

const mocks = vi.hoisted(() => ({ status: vi.fn(), header: vi.fn() }));
vi.mock('h3', async (original) => ({
  ...(await original<typeof import('h3')>()),
  setResponseStatus: mocks.status,
  setHeader: mocks.header,
}));

import handler from '../../server/api/[...path]';

beforeEach(() => vi.clearAllMocks());

it('returns a private JSON error envelope with 404 for an unmatched API route', async () => {
  const event = {
    path: '/api/health/report-nonexistent?token=private-fixture',
    context: { params: { path: 'health/report-nonexistent' } },
  } as unknown as H3Event;

  const response = await handler(event);

  expect(mocks.status).toHaveBeenCalledWith(event, 404);
  expect(mocks.header).toHaveBeenCalledWith(event, 'Cache-Control', 'private, no-store');
  expect(response).toMatchObject({
    schemaVersion: '1', status: 'error', result: null, authorization: null,
    error: { code: 'NOT_FOUND', message: 'API route not found.', retryable: false },
  });
  expect(response.requestId).toEqual(expect.any(String));
  expect(JSON.stringify(response)).not.toMatch(/private-fixture|report-nonexistent|<html/i);
});

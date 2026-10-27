// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEvent } from 'h3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createConversationExplanationRuntime } from '../../server/utils/conversation-explanation';
import type { LiquidityActor } from '@balanceframe/workflow-store';

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
const actor: LiquidityActor = {
  actorId: 'limiter-human',
  budgetId: 'budget',
  spaceId: 'space',
  membershipId: 'member',
};
function event() {
  const req = new IncomingMessage(new Socket());
  req.headers.origin = 'http://localhost:3000';
  return createEvent(req, new ServerResponse(req));
}
describe('server-owned conversation composition', () => {
  it('stays disabled independently of classification credentials and never configures a default provider', () => {
    vi.stubEnv('BALANCEFRAME_CONVERSATION_POLICY', '');
    vi.stubEnv('BALANCEFRAME_CONVERSATION_PROVIDER', '');
    vi.stubEnv('BALANCEFRAME_CONVERSATION_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-classification-secret');
    const runtime = createConversationExplanationRuntime(event(), actor);
    expect(runtime.provider).toBeUndefined();
    expect(runtime.policy()).toMatchObject({ mode: 'disabled', allowedProviders: [] });
  });
  it('retains the bounded actor/space/budget admission window across configuration instances', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'));
    const first = createConversationExplanationRuntime(event(), actor);
    for (let count = 0; count < 10; count++) expect(first.admit?.()).toBe(true);
    expect(createConversationExplanationRuntime(event(), actor).admit?.()).toBe(false);
    expect(
      createConversationExplanationRuntime(event(), {
        ...actor,
        actorId: 'another-human',
      }).admit?.(),
    ).toBe(true);
    vi.setSystemTime(new Date('2026-10-27T12:01:00Z'));
    expect(first.admit?.()).toBe(true);
  });
});

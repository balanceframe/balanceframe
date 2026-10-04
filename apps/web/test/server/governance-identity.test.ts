import { describe, expect, it, vi } from 'vitest';
import type { WorkflowStore } from '@balanceframe/workflow-store';
import { getActorId } from '../../server/utils/workflow-store';
import { hasLegacyFullRead } from '../../server/utils/legacy-financial-read';

vi.mock('h3', () => ({ setResponseStatus: vi.fn() }));

const agentCredential = {
  authenticated: true,
  method: 'api-key',
  principalType: 'agent',
  credentialId: 'key-classifier',
  credentialOwnerId: 'human-issuer',
  delegationId: 'delegation-classifier',
  delegationVersion: '3',
  user: { id: 'human-issuer' },
};

describe('governed web principal isolation', () => {
  it('attributes an agent key to its independently verified principal, never its human key owner', () => {
    const event = {
      context: { auth: { ...agentCredential, actorId: 'agent-classifier' } },
    };
    expect(getActorId(event)).toBe('agent-classifier');
  });

  it('does not turn an incomplete agent principal into its human credential owner', () => {
    expect(getActorId({ context: { auth: agentCredential } })).toBe('anonymous');
  });

  it('does not use an impersonated human session as governed consent or identity', () => {
    const event = {
      context: {
        auth: {
          authenticated: true,
          method: 'session',
          principalType: 'human',
          actorId: 'human-subject',
          user: { id: 'human-subject' },
          sessionId: 'impersonated-session',
          impersonatedBy: 'human-administrator',
        },
      },
    };
    expect(getActorId(event)).toBe('anonymous');
  });

  it('keeps ordinary session identity canonical rather than taking a request-body actor', () => {
    const event = {
      context: {
        auth: { authenticated: true, user: { id: 'human-member' } },
        body: { actorId: 'human-owner' },
      },
    };
    expect(getActorId(event)).toBe('human-member');
  });

  it('does not let instance ownership bypass a revoked whole-budget financial grant', async () => {
    const store = {
      evaluateAuthorization: vi.fn().mockResolvedValue({ allowed: true, reason: 'authorized' }),
      liquidity: {
        isOwner: vi.fn().mockReturnValue(true),
        isAuthorized: vi.fn().mockReturnValue(false),
      },
    } as unknown as WorkflowStore;
    expect(await hasLegacyFullRead(store, 'human-owner', 'private-budget')).toBe(false);
  });
});

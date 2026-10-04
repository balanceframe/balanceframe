import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore } from '../../workflow-store/src/store';
import { InAppChannelAdapter, NotificationRuntime, type NotificationPolicy } from '../src/notifications';

const now = '2098-01-01T12:00:00.000Z';
const human = (actorId: string) => ({ method: 'human-session' as const, actorId, sessionId: `session:${actorId}`, reauthenticatedAt: now });
const scope = 'budget:notification-fixture';
const privateMarker = 'private-source-notification-992';

describe('notification membership epochs and private source redaction', () => {
  let store: SqliteWorkflowStore;
  let runtime: NotificationRuntime;
  let adapter: InAppChannelAdapter;
  let spaceId: string;
  let membershipId: string;
  let policy: NotificationPolicy;
  beforeEach(async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    store = new SqliteWorkflowStore(':memory:');
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'notification-governance-fixture' });
    await store.finalizeBootstrap({ claimId: 'notification-governance-fixture', ownerUserId: 'owner' });
    const space = store.governance.createSpace({ actorId: 'owner', name: 'Shared notification space', kind: 'shared', now, auth: human('owner') });
    spaceId = space.id;
    store.governance.bindBudget({ spaceId, budgetId: 'notification-fixture', now, auth: human('owner') });
    await store.upsertActorMembership('recipient', 'active', [], '');
    membershipId = store.governance.addMembership({ spaceId, actorId: 'recipient', validFrom: now, now, auth: human('owner') }).id;
    grant();
    policy = {
      policyVersion: 'notification-policy-1',
      eligibility: [{ classifications: ['governance_alert'], minSeverity: 'normal', requiredCapability: 'notification:receive', requiredScope: scope }],
      recipients: [{ actorId: 'recipient', channels: ['in_app'], quietHours: null }],
      channels: [{ type: 'in_app', enabled: true, rateLimitPerMinute: 60, displayName: 'In-app' }],
      redaction: { private: { visibleFields: ['title', 'summary'] } },
      maxRetries: 1, defaultRedactionClass: 'private',
    };
    adapter = new InAppChannelAdapter();
    runtime = new NotificationRuntime(store, policy, [adapter]);
  });
  afterEach(() => { store?.close(); vi.useRealTimers(); });
  function grant() {
    store.governance.provisionResourceGrant({ spaceId, actorId: 'recipient', membershipId, budgetId: 'notification-fixture', capability: 'notification:receive', resourceKind: 'budget', resourceId: 'notification-fixture', granted: true, now });
  }
  async function enqueue(dedupKey?: string) {
    return runtime.create({ budgetId: 'notification-fixture', classification: 'governance_alert', severity: 'normal', recipientId: 'recipient', scope, dedupKey,
      payload: { title: 'Account evidence changed', summary: 'An authorized holder should review current evidence', privateAccount: privateMarker },
    });
  }
  it('persists original recipient and space provenance and exposes only allowed conclusions in every inbox DTO', async () => {
    const result = await enqueue();
    const inbox = await runtime.listOutbox('recipient', { budgetId: 'notification-fixture' });
    expect(inbox[0]?.redactedPayload).toEqual({ title: 'Account evidence changed', summary: 'An authorized holder should review current evidence' });
    expect(JSON.stringify(inbox)).not.toContain(privateMarker);
    const detail = await runtime.getOutboxDetail(result.outboxRecords[0]!.id, 'recipient');
    expect(detail?.redactedPayload).toEqual(inbox[0]?.redactedPayload);
    expect(JSON.stringify(detail)).not.toContain(privateMarker);
    expect(result.event).toMatchObject({ spaceId, recipientMembershipId: membershipId });
  });
  it('delivers only the authorized redacted conclusion to the original recipient period', async () => {
    const result = await enqueue();
    const outcome = await runtime.dispatch(result.outboxRecords[0]!.id, 'authorized-delivery');
    expect(outcome.status).toBe('delivered');
    expect(adapter.getDeliveries()[0]).toMatchObject({ recipientId: 'recipient', payload: { title: 'Account evidence changed', summary: 'An authorized holder should review current evidence' } });
    expect(JSON.stringify(adapter.getDeliveries())).not.toContain(privateMarker);
  });
  it('does not revive pending delivery or old inbox data after departure and explicit grants to a replacement period', async () => {
    const result = await enqueue();
    store.governance.revokeMembership({ spaceId, membershipId, now, auth: human('owner') });
    membershipId = store.governance.addMembership({ spaceId, actorId: 'recipient', validFrom: now, now, auth: human('owner') }).id;
    grant();
    expect(await runtime.listOutbox('recipient', { budgetId: 'notification-fixture' })).toEqual([]);
    expect(await runtime.getOutboxDetail(result.outboxRecords[0]!.id, 'recipient')).toBeNull();
    expect(await runtime.getStatus({
      actorId: 'recipient', budgetId: 'notification-fixture', canReadEvent: async () => true,
    })).toMatchObject({ pendingCount: 0, failedCount: 0 });
    expect((await runtime.dispatch(result.outboxRecords[0]!.id, 'rejoined-delivery')).status).toBe('failed');
    expect(adapter.getDeliveries()).toEqual([]);
  });
  it('rechecks current rights at dispatch even when an additional producer hook accepts', async () => {
    const result = await enqueue();
    runtime.setReAuthorizationHook(async () => true);
    store.governance.setResourceGrant({ spaceId, actorId: 'recipient', membershipId, budgetId: 'notification-fixture', capability: 'notification:receive', resourceKind: 'budget', resourceId: 'notification-fixture', granted: false, now, auth: human('owner') });
    expect((await runtime.dispatch(result.outboxRecords[0]!.id, 'revoked-delivery')).status).toBe('failed');
    expect(adapter.getDeliveries()).toEqual([]);
  });
  it('deduplicates within a period without suppressing new notifications after a replacement period', async () => {
    const original = await enqueue('same-producer-revision');
    expect((await enqueue('same-producer-revision')).event.id).toBe(original.event.id);
    store.governance.revokeMembership({ spaceId, membershipId, now, auth: human('owner') });
    membershipId = store.governance.addMembership({ spaceId, actorId: 'recipient', validFrom: now, now, auth: human('owner') }).id;
    grant();
    const replacement = await enqueue('same-producer-revision');
    expect(replacement.event.id).not.toBe(original.event.id);
    expect(replacement.outboxRecords[0]?.deliveryKey).not.toBe(original.outboxRecords[0]?.deliveryKey);
    const inbox = await runtime.listOutbox('recipient', { budgetId: 'notification-fixture' });
    expect(inbox.map(({ event }) => event.id)).toEqual([replacement.event.id]);
  });
  it('captures each authorized recipient period when a normal producer fans out without identity arguments', async () => {
    await store.upsertActorMembership('second', 'active', [], '');
    const second = store.governance.addMembership({ spaceId, actorId: 'second', validFrom: now, now, auth: human('owner') });
    store.governance.provisionResourceGrant({ spaceId, actorId: 'second', membershipId: second.id, budgetId: 'notification-fixture', capability: 'notification:receive', resourceKind: 'budget', resourceId: 'notification-fixture', granted: true, now });
    await store.upsertActorMembership('outside', 'active', ['notification:receive'], '*');
    runtime = new NotificationRuntime(store, {
      ...policy,
      eligibility: [{ classifications: ['governance_alert'], minSeverity: 'normal', requiredCapability: 'notification:receive' }],
      recipients: ['recipient', 'second', 'outside'].map((actorId) => ({ actorId, channels: ['in_app'], quietHours: null })),
    }, [adapter]);
    const result = await runtime.create({ budgetId: 'notification-fixture', classification: 'governance_alert', severity: 'normal', payload: { title: 'Account evidence changed', privateAccount: privateMarker } });
    const captured = await Promise.all(result.outboxRecords.map((outbox) => store.getNotificationEvent(outbox.eventId)));
    expect(captured.map((event) => ({ actor: event?.recipientId, membership: event?.recipientMembershipId, space: event?.spaceId }))).toEqual([
      { actor: 'recipient', membership: membershipId, space: spaceId },
      { actor: 'second', membership: second.id, space: spaceId },
    ]);
    for (const outbox of result.outboxRecords)
      expect((await runtime.dispatch(outbox.id, `fanout:${outbox.id}`)).status).toBe('delivered');
    expect(adapter.getDeliveries().map(({ recipientId }) => recipientId)).toEqual(['recipient', 'second']);
    expect(JSON.stringify(adapter.getDeliveries())).not.toContain(privateMarker);
    expect(await runtime.listOutbox('outside', { budgetId: 'notification-fixture' })).toEqual([]);
  });
});

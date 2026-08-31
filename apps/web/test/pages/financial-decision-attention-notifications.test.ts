import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';

const mockFetch = vi.fn();
vi.stubGlobal('$fetch', mockFetch);

vi.mock('../../lib/auth-client', () => ({
  authClient: {
    useSession: vi.fn(() => ({
      value: {
        data: {
          user: {
            id: 'actor-financial-attention',
            email: 'attention@example.test',
          },
        },
        isPending: false,
      },
    })),
    signOut: vi.fn(),
  },
}));

import IndexPage from '../../app/pages/index.vue';
import NotificationsPage from '../../app/pages/notifications/index.vue';
import EvidenceDrawer from '../../app/components/EvidenceDrawer.vue';
import FindingCard from '../../app/components/FindingCard.vue';
import ReasonCodeList from '../../app/components/ReasonCodeList.vue';

const RAW_EVENT_SECRET = 'provider-access-token-must-never-reach-the-browser';
const SNAPSHOT_ID = 'snapshot-attention-2026-08-23';
const POLICY_VERSION = 'financial-attention-v1';
const REVISION = 'sha256:attention-revision-1';
const CAPTURED_AT = '2026-08-23T12:00:00Z';
const ACCOUNT_CARD_UUID = '7728bc62-67cc-42e1-957d-1c263f677f81';
const CATEGORY_GROCERIES_UUID = '6711370f-52c5-43dc-b59a-72f1ec42d1b7';
const CATEGORY_RENT_UUID = '369d73f3-951f-40dc-9dcb-3d268e0d6c12';
const BANK_SYNC_EVIDENCE_UUID = '550132bd-9ded-45f1-9401-39c40330a5bd';

const AnalysisPageStub = {
  template: `
    <main :aria-label="title">
      <div v-if="error" role="alert">{{ error.message }}</div>
      <slot name="error-actions" />
      <slot name="content" />
    </main>
  `,
  props: ['title', 'loading', 'error', 'freshness', 'insufficientData'],
};

const UCardStub = {
  template:
    '<div><header><slot name="header" /></header><slot /><footer><slot name="footer" /></footer></div>',
};

const UButtonStub = {
  template:
    '<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot />{{ label }}</button>',
  props: ['label', 'disabled', 'variant', 'size', 'color', 'icon', 'to'],
  emits: ['click'],
};

const pageGlobals = {
  components: {
    EvidenceDrawer,
    FindingCard,
    ReasonCodeList,
  },
  stubs: {
    AnalysisPage: AnalysisPageStub,
    AnalysisTable: {
      template:
        '<table><tbody><tr v-for="(row, index) in rows" :key="index"><td>{{ row.payeeName }}</td></tr></tbody></table>',
      props: ['columns', 'rows'],
    },
    FreshnessBanner: {
      template: '<div role="status"><slot /></div>',
      props: ['freshness'],
    },
    InsufficientDataPanel: {
      template: '<div role="status">Insufficient data</div>',
      props: ['reason'],
    },
    NotificationStatusBadge: {
      template: '<span>{{ status }}</span>',
      props: ['status'],
    },
    NuxtLink: {
      template: '<a :href="to"><slot /></a>',
      props: ['to'],
    },
    SemanticAmount: {
      template: '<span>{{ amount?.minorUnits }} {{ amount?.currency }}</span>',
      props: ['amount'],
    },
    UAlert: {
      template: '<div role="status"><strong>{{ title }}</strong> {{ description }}</div>',
      props: ['title', 'description', 'color', 'variant'],
    },
    UBadge: {
      template: '<span><slot />{{ label }}</span>',
      props: ['label', 'color', 'variant'],
    },
    UButton: UButtonStub,
    UCard: UCardStub,
    UContainer: { template: '<div><slot /></div>' },
    UFormGroup: {
      template: '<label>{{ label }}<slot /></label>',
      props: ['label'],
    },
    UInput: {
      template:
        '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
      props: ['modelValue', 'placeholder'],
      emits: ['update:modelValue'],
    },
  },
};

function okEnvelope(
  result: unknown,
  capability: 'observe' | 'notification:receive',
  dataFreshness: Record<string, unknown> | null = null,
) {
  return {
    schemaVersion: '1',
    requestId: `request-${capability}`,
    status: 'ok' as const,
    dataFreshness,
    authorization: {
      actorId: 'actor-financial-attention',
      capability,
      allowed: true,
    },
    result,
    error: null,
  };
}

type IssueInput = {
  classification:
    | 'account_readiness_blocker'
    | 'transfer_needs_attention'
    | 'reservation_conflict'
    | 'commitment_conflict'
    | 'evidence_connector_degradation'
    | 'unresolved_material_evidence';
  code: string;
  message: string;
  severity: 'critical' | 'warning' | 'info';
  effect: 'blocks' | 'qualifies';
  scope: { kind: 'account' | 'category' | 'transaction' | 'claim'; id: string };
  categoryName: string;
  remediationCode: string;
  remediationAction: string;
  redaction: 'visible' | 'redacted';
  evidenceId: string;
  evidenceKind: string;
  authorized: boolean;
  findingVersion: number;
};

function financialAttentionItem(input: IssueInput) {
  const dedupKey = `financial-decision:${input.classification}`;
  return {
    code: input.code,
    message: input.message,
    severity: input.severity,
    entityId: input.scope.id,
    entityType: input.scope.kind,
    categoryName: input.categoryName,
    classification: input.classification,
    issue: {
      code: input.code,
      severity: input.severity,
      effect: input.effect,
      scope: input.scope,
      evidence: [
        {
          evidenceId: input.evidenceId,
          kind: input.evidenceKind,
          authorized: input.authorized,
          redaction: input.redaction,
        },
      ],
      remediation: {
        code: input.remediationCode,
        action: input.remediationAction,
      },
      redaction: input.redaction,
    },
    snapshotId: SNAPSHOT_ID,
    policyVersion: POLICY_VERSION,
    revision: REVISION,
    dedupKey,
    findingId: dedupKey,
    findingStatus: 'open',
    findingVersion: input.findingVersion,
    firstObservedAt: CAPTURED_AT,
    lastObservedAt: CAPTURED_AT,
    expiresAt: null,
  };
}

const accountReadiness = financialAttentionItem({
  classification: 'account_readiness_blocker',
  code: 'account_freshness_coverage',
  message: 'Card account evidence must be refreshed.',
  severity: 'critical',
  effect: 'blocks',
  scope: { kind: 'account', id: ACCOUNT_CARD_UUID },
  categoryName: 'Everyday card',
  remediationCode: 'refresh_account_evidence',
  remediationAction: 'Refresh the affected account before evaluating again.',
  redaction: 'visible',
  evidenceId: BANK_SYNC_EVIDENCE_UUID,
  evidenceKind: 'bank_sync',
  authorized: true,
  findingVersion: 4,
});

const connectorDegradation = financialAttentionItem({
  classification: 'evidence_connector_degradation',
  code: 'account_freshness_coverage',
  message: 'An authorized account source is unavailable.',
  severity: 'critical',
  effect: 'blocks',
  scope: { kind: 'account', id: 'account-restricted' },
  categoryName: 'Restricted account',
  remediationCode: 'reconnect_source',
  remediationAction: 'Reconnect the account source before evaluating again.',
  redaction: 'redacted',
  evidenceId: 'restricted-reference-1',
  evidenceKind: 'connector_error',
  authorized: false,
  findingVersion: 2,
});

const unresolvedEvidence = financialAttentionItem({
  classification: 'unresolved_material_evidence',
  code: 'future_vendor_signal',
  message: 'Material financial evidence remains unresolved.',
  severity: 'warning',
  effect: 'blocks',
  scope: { kind: 'claim', id: 'claim-material-7' },
  categoryName: 'Material evidence review',
  remediationCode: 'review_material_evidence',
  remediationAction: 'Review the supporting evidence before evaluating again.',
  redaction: 'visible',
  evidenceId: 'normalized-evidence-7',
  evidenceKind: 'normalized_evidence',
  authorized: true,
  findingVersion: 1,
});
const transferAttention = financialAttentionItem({
  classification: 'transfer_needs_attention',
  code: 'duplicate_transfer_ambiguity',
  message: 'A possible incomplete transfer needs review.',
  severity: 'warning',
  effect: 'qualifies',
  scope: { kind: 'transaction', id: 'transfer-one-sided' },
  categoryName: 'Card transfer',
  remediationCode: 'review_transfer',
  remediationAction: 'Review the related transactions and resolve the transfer ambiguity.',
  redaction: 'visible',
  evidenceId: 'transfer-counterpart-card',
  evidenceKind: 'transfer_candidate',
  authorized: true,
  findingVersion: 3,
});

const reservationConflict = financialAttentionItem({
  classification: 'reservation_conflict',
  code: 'reservation_conflict',
  message: 'A category reservation conflicts with available funding.',
  severity: 'warning',
  effect: 'qualifies',
  scope: { kind: 'category', id: CATEGORY_GROCERIES_UUID },
  categoryName: 'Groceries',
  remediationCode: 'review_reservation',
  remediationAction: 'Review or release the conflicting reservation.',
  redaction: 'visible',
  evidenceId: 'reservation-groceries-3',
  evidenceKind: 'reservation',
  authorized: true,
  findingVersion: 2,
});

const commitmentConflict = financialAttentionItem({
  classification: 'commitment_conflict',
  code: 'schedule_coverage',
  message: 'A scheduled commitment conflicts with this financial state.',
  severity: 'info',
  effect: 'qualifies',
  scope: { kind: 'category', id: CATEGORY_RENT_UUID },
  categoryName: 'Rent',
  remediationCode: 'review_commitment',
  remediationAction: 'Review the scheduled commitment before proceeding.',
  redaction: 'visible',
  evidenceId: 'schedule-rent-4',
  evidenceKind: 'schedule',
  authorized: true,
  findingVersion: 1,
});

const attentionResult = {
  blockers: [accountReadiness, connectorDegradation, unresolvedEvidence],
  alerts: [transferAttention, reservationConflict, commitmentConflict],
  recurrences: [],
  categoryRisks: [],
  targetProgress: {
    overallLabel: 'unknown',
    healthyCount: 0,
    atRiskCount: 0,
    sinkingFundsOnTrack: 0,
    totalSinkingFunds: 0,
  },
};

const attentionFreshness = {
  actualDownloadedAt: '2026-08-23T11:58:00Z',
  bankSyncedAt: '2026-08-23T11:57:00Z',
  pendingTransactionsIncluded: true,
  stalenessDays: 0,
  isStale: false,
};

const notificationStatusResult = {
  healthy: true,
  storeConnected: true,
  channelStatuses: [{ channel: 'in_app', healthy: true }],
  pendingCount: 0,
  failedCount: 0,
  disabledChannels: [],
  outageChannels: [],
  policyVersion: POLICY_VERSION,
  recipientCount: 1,
};

const sanitizedInboxResult = {
  items: [
    {
      outbox: {
        id: 'outbox-material-evidence',
        eventId: 'event-material-evidence',
        deliveryKey: 'delivery-material-evidence',
        channelType: 'in_app',
        channelConfigVersion: null,
        status: 'delivered',
        attemptCount: 1,
        maxAttempts: 3,
        claimExpiresAt: null,
        lastAttemptedAt: '2026-08-23T12:00:01Z',
        nextAttemptAt: null,
        acknowledgedAt: null,
        failedAt: null,
        failureReason: null,
        suppressedAt: null,
        suppressedReason: null,
        correlationId: 'financial-decision:unresolved_material_evidence',
        createdAt: CAPTURED_AT,
        updatedAt: '2026-08-23T12:00:01Z',
      },
      event: {
        id: 'event-material-evidence',
        eventVersion: 1,
        budgetId: 'budget-attention',
        classification: 'unresolved_material_evidence',
        recipientId: 'actor-financial-attention',
        scope: 'budget:budget-attention',
        redactionClass: 'restricted',
        channelConfigVersion: null,
        policyVersion: POLICY_VERSION,
        correlationId: 'financial-decision:unresolved_material_evidence',
        createdAt: CAPTURED_AT,
      },
      redactedPayload: {
        title: 'Restricted finding',
        summary: 'Material evidence needs review.',
        classification: 'unresolved_material_evidence',
        scope: 'budget:budget-attention',
        snapshotId: SNAPSHOT_ID,
      },
      deliveryAttempts: [
        {
          id: 'attempt-material-evidence-1',
          outboxId: 'outbox-material-evidence',
          attemptNumber: 1,
          status: 'delivered',
          responseCode: 'accepted',
          attemptedAt: '2026-08-23T12:00:01Z',
          success: true,
          deliveredAt: '2026-08-23T12:00:01Z',
          failureReason: null,
        },
      ],
    },
  ],
  count: 1,
};

const notificationPolicyRecord = {
  id: 'notification-policy-attention',
  spaceId: 'default',
  policyKey: 'delivery',
  policyVersion: POLICY_VERSION,
  policy: JSON.stringify({
    maxRetries: 3,
    defaultRedactionClass: 'restricted',
    redaction: {
      restricted: {
        visibleFields: ['title', 'summary', 'classification', 'scope', 'snapshotId'],
      },
    },
  }),
  isActive: true,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: CAPTURED_AT,
};

function installApiMocks() {
  mockFetch.mockImplementation((url: string, options?: Record<string, unknown>) => {
    if (url === '/api/home/attention') {
      return Promise.resolve(okEnvelope(attentionResult, 'observe', attentionFreshness));
    }
    if (url === '/api/notifications/status') {
      return Promise.resolve(okEnvelope(notificationStatusResult, 'notification:receive'));
    }
    if (url === '/api/notifications/inbox') {
      return Promise.resolve(okEnvelope(sanitizedInboxResult, 'notification:receive'));
    }
    if (url === '/api/notifications/policy') {
      return Promise.resolve(okEnvelope(notificationPolicyRecord, 'observe'));
    }
    if (url === '/api/notifications/acknowledge' && options?.method === 'POST') {
      return Promise.resolve(
        okEnvelope({ outboxId: 'outbox-material-evidence', status: 'acknowledged' }, 'observe'),
      );
    }
    return Promise.reject(new Error(`Unexpected API request: ${url}`));
  });
}

async function mountAttentionPage() {
  const wrapper = mount(IndexPage, { global: pageGlobals });
  await flushPromises();
  return wrapper;
}

async function mountNotificationsPage() {
  const wrapper = mount(NotificationsPage, { global: pageGlobals });
  await flushPromises();
  return wrapper;
}

function buttonNamed(wrapper: VueWrapper, name: string) {
  const button = wrapper.findAll('button').find((candidate) => candidate.text().trim() === name);
  if (!button) throw new Error(`Button with accessible name "${name}" was not found`);
  return button;
}

beforeEach(() => {
  mockFetch.mockReset();
  installApiMocks();
});

describe('existing / financial-decision attention surface', () => {
  it('presents all six classifications in one priority surface with blockers before alerts', async () => {
    const wrapper = await mountAttentionPage();
    const surfaces = wrapper.findAll('section[aria-label="Financial decision attention"]');

    expect(surfaces).toHaveLength(1);
    const surface = surfaces[0];
    const expectedClassifications = [
      'Account Readiness Blocker',
      'Transfer Needs Attention',
      'Reservation Conflict',
      'Commitment Conflict',
      'Evidence Connector Degradation',
      'Unresolved Material Evidence',
    ];
    for (const classification of expectedClassifications) {
      expect(surface.text()).toContain(classification);
    }

    expect(surface.findAllComponents(FindingCard)).toHaveLength(6);
    expect(surface.findAllComponents(ReasonCodeList).length).toBeGreaterThanOrEqual(6);
    expect(surface.findAllComponents(EvidenceDrawer)).toHaveLength(6);

    const blockerPosition = surface.text().indexOf('Card account evidence must be refreshed.');
    const alertPosition = surface.text().indexOf('A possible incomplete transfer needs review.');
    expect(blockerPosition).toBeGreaterThanOrEqual(0);
    expect(alertPosition).toBeGreaterThan(blockerPosition);
  });

  it('uses human names and concise issue metadata while keeping technical identity secondary', async () => {
    const wrapper = await mountAttentionPage();
    const surface = wrapper.get('section[aria-label="Financial decision attention"]');
    const text = surface.text().replace(/\s+/g, ' ').trim();

    const accountCard = surface.get(
      '[aria-label="Finding: Card account evidence must be refreshed."]',
    );
    expect(accountCard.get('[aria-label="Account: Everyday card"]').text()).toBe('Everyday card');
    const accountMetadata = accountCard.get(
      '[aria-label="Issue metadata: Critical, blocks, open"]',
    );
    expect(accountMetadata.text()).toContain('Critical');
    expect(accountMetadata.text()).toContain('Blocks');
    expect(accountMetadata.text()).toContain('Open');

    const groceriesCard = surface.get(
      '[aria-label="Finding: A category reservation conflicts with available funding."]',
    );
    expect(groceriesCard.get('[aria-label="Category: Groceries"]').text()).toBe('Groceries');

    expect(text).toContain('Refresh the affected account before evaluating again.');
    expect(text).not.toContain('Classification:');
    expect(text).not.toContain('Scope:');
    expect(text).not.toContain('Finding status:');
    expect(text).not.toContain('Finding version:');
    expect(text).not.toContain('Snapshot:');
    expect(text).not.toContain('Policy:');
    expect(text).not.toContain('Revision:');
    expect(text).not.toContain(ACCOUNT_CARD_UUID);
    expect(text).not.toContain(CATEGORY_GROCERIES_UUID);
    expect(text).not.toContain(BANK_SYNC_EVIDENCE_UUID);
    expect(text).not.toContain(CATEGORY_RENT_UUID);
    expect(text).not.toContain(SNAPSHOT_ID);
    expect(text).not.toContain(REVISION);

    const provenanceToggle = accountCard.get('button[aria-label="Show technical provenance"]');
    expect(provenanceToggle.attributes('aria-expanded')).toBe('false');
    await provenanceToggle.trigger('click');
    const provenance = accountCard.get('[role="region"][aria-label="Technical provenance"]');
    expect(provenance.text()).toContain(SNAPSHOT_ID);
    expect(provenance.text()).toContain(POLICY_VERSION);
    expect(provenance.text()).toContain(REVISION);

    const restrictedItem = surface
      .findAll('[role="listitem"]')
      .find((item) => item.text().includes('Evidence Connector Degradation'));
    expect(restrictedItem).toBeDefined();
    const drawer = restrictedItem!.findComponent(EvidenceDrawer);
    expect(drawer.exists()).toBe(true);
    await drawer.get('button[aria-label="Show evidence summary"]').trigger('click');
    const restrictedReference = drawer.get(
      '[role="region"][aria-label="Evidence summary"] [aria-label="Restricted evidence: 1 reference"]',
    );
    expect(restrictedReference.exists()).toBe(true);
    expect(drawer.text()).not.toContain('restricted-reference-1');
    expect(drawer.text()).not.toContain('connector_error');
    expect(drawer.text()).not.toContain('Connector Error');
    expect(wrapper.html()).not.toContain(RAW_EVENT_SECRET);
    expect(wrapper.text()).not.toContain('undefined');
    expect(wrapper.text()).not.toContain('[object Object]');
  });

  it('keeps a forward-compatible unknown issue code visible as a safe label', async () => {
    const wrapper = await mountAttentionPage();
    const surface = wrapper.get('section[aria-label="Financial decision attention"]');

    expect(surface.text()).toMatch(/Future vendor signal/i);
    expect(surface.text()).not.toContain('Unknown financial amount: 0');
    expect(surface.text()).not.toContain('$0.00');
  });
});

describe('existing /notifications financial-decision delivery surface', () => {
  it('renders only the safe redacted summary and sanitized event/delivery metadata', async () => {
    const wrapper = await mountNotificationsPage();
    const page = wrapper.get('main[aria-label="Notifications"]');
    const text = page.text();

    expect(text).toContain('Restricted finding');
    expect(text).toContain('Material evidence needs review.');
    expect(text).toContain('Unresolved Material Evidence');
    expect(text).toContain('Delivery state: Delivered');
    expect(text).toContain('Delivery History');
    expect(text).toContain('Delivery is not current proof');
    expect(text).toContain(`Policy: ${POLICY_VERSION}`);
    expect(text).toContain(`Snapshot: ${SNAPSHOT_ID}`);

    expect(wrapper.html()).not.toContain(RAW_EVENT_SECRET);
    expect(text).not.toContain('providerToken');
    expect(text).not.toContain('rawEvidence');
    expect(text).not.toContain('Event payload');
  });

  it('acknowledges delivery without changing or mutating the underlying finding state', async () => {
    const attentionWrapper = await mountAttentionPage();
    const notificationWrapper = await mountNotificationsPage();

    await buttonNamed(notificationWrapper, 'Acknowledge').trigger('click');
    expect(notificationWrapper.text()).toContain('does not change the underlying finding');
    await buttonNamed(notificationWrapper, 'Confirm').trigger('click');
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith('/api/notifications/acknowledge', {
      method: 'POST',
      body: { outboxId: 'outbox-material-evidence' },
    });
    expect(notificationWrapper.text()).toContain('does not affect any associated findings');
    expect(attentionWrapper.find('[data-finding-status="open"]').exists()).toBe(true);

    const requestedUrls = mockFetch.mock.calls.map(([url]) => String(url));
    expect(requestedUrls.some((url) => url.includes('/findings/'))).toBe(false);
  });

  it('keeps the existing routes and adds no specialized inbox navigation', async () => {
    const attentionWrapper = await mountAttentionPage();
    const notificationWrapper = await mountNotificationsPage();
    const hrefs = [
      ...attentionWrapper.findAll('a[href]'),
      ...notificationWrapper.findAll('a[href]'),
    ]
      .map((link) => link.attributes('href'))
      .filter((href): href is string => typeof href === 'string');

    expect(hrefs).not.toContain('/inbox');
    expect(hrefs).not.toContain('/notifications/inbox');
    expect(
      hrefs.some((href) => /connector|transfer|reservation|commitment|evidence/.test(href)),
    ).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import EvidenceItemRules from '../../app/components/EvidenceItemRules.vue';
import fixture from '../../../../protocol/fixtures/transaction-evidence-rule.json';
import { evidenceItemRuleViewSchema } from '../../app/utils/evidence-item-rules-client';
const auth = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock('../../app/utils/reauthentication', () => ({ reauthenticateHuman: auth.confirm }));
const request = vi.fn();
const wrappers: VueWrapper[] = [];
const record = {
  id: fixture.rule.id,
  state: 'proposed',
  payloadHash: 'a'.repeat(64),
  connectorId: 'retail',
  accountId: 'checking',
  policyVersion: 'policy-1',
  expiresAt: '2026-10-28T12:00:00Z',
  rule: fixture.rule,
  simulation: {
    ruleId: fixture.rule.id,
    resolutionHash: 'b'.repeat(64),
    matches: [
      {
        receiptId: 'receipt-1',
        lineId: 'line-1',
        currentCategoryId: null,
        proposedCategoryId: 'food',
        conflict: false,
      },
    ],
    conflicts: [],
    falsePositiveRisk: 'review_required',
    requiresApproval: true,
  },
  examples: [
    {
      documentId: 'document',
      receiptId: 'receipt-1',
      lineId: 'line-1',
      rawDescription: 'two items',
      normalizedDescription: 'item',
      sku: 'sku-1',
      amount: fixture.evidence.receipts[0]!.lines[0]!.net,
      currentCategoryId: null,
    },
  ],
  actualInteraction: {
    kind: 'local_item_suggestion_only',
    reasonCode: 'actual_item_predicate_unavailable',
    actualRuleIds: ['actual-rule'],
  },
  approvals: [],
};
const reply = (result: unknown) =>
  new Response(JSON.stringify({ status: 'ok', result, error: null }));
beforeEach(() => {
  vi.stubGlobal('fetch', request);
  request.mockReset();
  auth.confirm.mockReset().mockResolvedValue(undefined);
  request.mockImplementation(async (url: string) =>
    url.endsWith('targets')
      ? reply({
          accounts: [{ id: 'checking', name: 'Fixture Checking' }],
          categories: [{ id: 'food', name: 'Fixture Groceries' }],
        })
      : reply([]),
  );
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});
function panel() {
  const wrapper = mount(EvidenceItemRules, { props: { connectorIds: ['retail'], refreshKey: 0 } });
  wrappers.push(wrapper);
  return wrapper;
}
describe('exact receipt item-rule review', () => {
  it('simulates exact source and item conditions, displays historical examples and separately approves/revokes an exact hash', async () => {
    const wrapper = panel();
    expect(request).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="load-item-rules"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Fixture Checking');
    await wrapper.get('[data-testid="item-rule-account"]').setValue('checking');
    await wrapper.get('[data-testid="item-rule-category"]').setValue('food');
    await wrapper.get('[data-testid="item-rule-source"]').setValue('retail');
    await wrapper.get('[data-testid="item-rule-funding"]').setValue('card-1');
    await wrapper.get('[data-testid="item-rule-sku"]').setValue('sku-1');
    expect(
      wrapper.get<HTMLButtonElement>('[data-testid="simulate-item-rule"]').element.disabled,
    ).toBe(true);
    await wrapper.get('[data-testid="item-rule-merchant"]').setValue('person-1');
    request.mockResolvedValueOnce(reply(record));
    await wrapper.get('[data-testid="simulate-item-rule"]').trigger('click');
    await flushPromises();
    expect(JSON.parse(request.mock.calls.at(-1)![1].body)).toEqual({
      connectorId: 'retail',
      accountId: 'checking',
      fundingInstrumentId: 'card-1',
      counterparty: 'person-1',
      sku: 'sku-1',
      normalizedDescription: null,
      categoryId: 'food',
    });
    expect(wrapper.text()).toContain('Exact merchant person-1');
    expect(wrapper.text()).toContain('two items');
    expect(wrapper.text()).toContain('12.00 USD');
    expect(wrapper.text()).toContain('actual-rule');
    expect(wrapper.text()).toContain(record.payloadHash);
    expect(
      wrapper.get<HTMLButtonElement>('[data-testid="approve-item-rule"]').element.disabled,
    ).toBe(true);
    await wrapper.get('[data-testid="item-rule-password"]').setValue('test-only-password');
    request.mockResolvedValueOnce(
      reply({
        ...record,
        state: 'approved',
        approvals: [{ actorId: 'human', action: 'approved', at: '2026-10-21T12:00:00Z' }],
      }),
    );
    await wrapper.get('[data-testid="approve-item-rule"]').trigger('click');
    await flushPromises();
    expect(auth.confirm).toHaveBeenCalledWith('test-only-password');
    expect(request.mock.calls.at(-1)![0]).toBe('/api/evidence/rules/approve');
    expect(JSON.parse(request.mock.calls.at(-1)![1].body)).toEqual({
      proposalId: record.id,
      payloadHash: record.payloadHash,
    });
    expect(wrapper.get<HTMLInputElement>('[data-testid="item-rule-password"]').element.value).toBe(
      '',
    );
    request.mockResolvedValueOnce(
      reply([
        {
          proposalId: record.id,
          payloadHash: record.payloadHash,
          accountId: 'checking',
          receiptId: 'receipt-1',
          lineId: 'line-1',
          categoryId: 'food',
          sourceDocumentId: 'document',
          simulationHash: 'b'.repeat(64),
          state: 'suggested',
          reasonCodes: ['approved_exact_sku_rule'],
        },
      ]),
    );
    await wrapper.get('[data-testid="load-item-suggestions"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('approved_exact_sku_rule');
    await wrapper.get('[data-testid="item-rule-password"]').setValue('fresh-password');
    request.mockResolvedValueOnce(reply({ ...record, state: 'revoked' }));
    await wrapper.get('[data-testid="revoke-item-rule"]').trigger('click');
    await flushPromises();
    expect(request.mock.calls.at(-1)![0]).toBe('/api/evidence/rules/revoke');
    expect(request.mock.calls.some(([url]) => /execute|proposals/.test(url))).toBe(false);
  });
  it('keeps historical conflicts unapprovable and rejects malformed results without retaining credentials', async () => {
    request.mockImplementation(async (url: string) =>
      url.endsWith('targets')
        ? reply({ accounts: [], categories: [] })
        : reply([
            {
              ...record,
              simulation: { ...record.simulation, conflicts: ['actual_rule_category_conflict'] },
            },
          ]),
    );
    const wrapper = panel();
    await wrapper.get('[data-testid="load-item-rules"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="item-rule-password"]').setValue('password');
    expect(
      wrapper.get<HTMLButtonElement>('[data-testid="approve-item-rule"]').element.disabled,
    ).toBe(true);
    expect(wrapper.text()).toContain('actual_rule_category_conflict');
    request.mockResolvedValue(reply({ bad: true }));
    await wrapper.get('[data-testid="load-item-rules"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('Item rules unavailable');
    expect(wrapper.text()).not.toContain(record.payloadHash);
    expect(wrapper.get<HTMLInputElement>('[data-testid="item-rule-password"]').element.value).toBe(
      '',
    );
  });
  it('drops source content and ignores late results when the selected context changes', async () => {
    let complete: ((value: Response) => void) | undefined;
    request.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const wrapper = panel();
    await wrapper.get('[data-testid="load-item-rules"]').trigger('click');
    await wrapper.setProps({ refreshKey: 1 });
    complete?.(reply([record]));
    await flushPromises();
    expect(wrapper.text()).not.toContain(record.payloadHash);
    expect(wrapper.find('[data-testid="item-rule-account"]').exists()).toBe(false);
  });
});

it('retains exact merchant spelling in review data and rejects an unscoped legacy view', () => {
  expect(evidenceItemRuleViewSchema.parse(record).rule.counterparty).toBe('person-1');
  const legacy = structuredClone(record);
  delete (legacy.rule as Record<string, unknown>).counterparty;
  expect(() => evidenceItemRuleViewSchema.parse(legacy)).toThrow();
});

it('inspects repeated human outcomes and creates an ordinary unapproved proposal from an exact candidate hash', async () => {
  const wrapper = panel();
  await wrapper.get('[data-testid="load-item-rules"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-testid="item-rule-source"]').setValue('retail');
  await wrapper.get('[data-testid="item-rule-account"]').setValue('checking');
  const learned = {
    contractVersion: '1',
    resolutionHash: 'b'.repeat(64),
    connectorId: 'retail',
    accountId: 'checking',
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    conflicts: [],
    candidates: [
      {
        candidateHash: 'c'.repeat(64),
        rule: fixture.rule,
        accountId: 'checking',
        sourceIdentities: ['a'.repeat(64), 'b'.repeat(64)],
        documentIds: ['doc-one', 'doc-two'],
        reviewCount: 2,
        requiresApproval: true,
        examples: [
          { receiptId: 'receipt-1', lineId: 'line-1', documentId: 'doc-one', categoryId: 'food' },
          { receiptId: 'receipt-2', lineId: 'line-2', documentId: 'doc-two', categoryId: 'food' },
        ],
      },
    ],
  };
  request.mockResolvedValueOnce(reply(learned));
  await wrapper.get('[data-testid="learn-item-candidates"]').trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('2 independent reviewed sources');
  expect(wrapper.text()).toContain('Exact merchant person-1');
  request.mockResolvedValueOnce(reply(record));
  await wrapper.get('[data-testid="propose-learned-item-rule"]').trigger('click');
  await flushPromises();
  expect(request.mock.calls.at(-1)![0]).toBe('/api/evidence/rules/from-candidate');
  expect(JSON.parse(request.mock.calls.at(-1)![1].body)).toEqual({
    connectorId: 'retail',
    accountId: 'checking',
    candidateHash: 'c'.repeat(64),
  });
  expect(auth.confirm).not.toHaveBeenCalled();
  expect(wrapper.text()).toContain('proposed');
});

it('offers explicit contextual criteria with reviewed-history risk and preserves separate approval', async () => {
  const wrapper = mount(EvidenceItemRules, { props: { connectorIds: ['retail'] } });
  wrappers.push(wrapper);
  await wrapper.get('[data-testid="load-item-rules"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-testid="item-rule-source"]').setValue('retail');
  await wrapper.get('[data-testid="item-rule-account"]').setValue('checking');
  await wrapper.get('[data-testid="item-rule-merchant"]').setValue('Store A');
  await wrapper.get('[data-testid="item-rule-funding"]').setValue('card-1');
  await wrapper.get('[data-testid="item-rule-category"]').setValue('food');
  await wrapper.get('[data-testid="item-rule-criterion"]').setValue('department');
  await wrapper.get('[data-testid="item-rule-criterion-value"]').setValue('produce');
  const contextual = {
    ...record,
    rule: {
      ...record.rule,
      counterparty: 'Store A',
      sku: null,
      normalizedDescription: null,
      criterion: { kind: 'department', value: 'produce' },
    },
    simulation: { ...record.simulation, falsePositiveRisk: 'broader_scope_review_required' },
  };
  request.mockResolvedValueOnce(reply(contextual));
  await wrapper.get('[data-testid="simulate-item-rule"]').trigger('click');
  await flushPromises();
  const body = JSON.parse(request.mock.calls.at(-1)![1].body);
  expect(body).toMatchObject({
    counterparty: 'Store A',
    sku: null,
    normalizedDescription: null,
    criterion: { kind: 'department', value: 'produce' },
  });
  expect(body).not.toHaveProperty('criterionKind');
  expect(body).not.toHaveProperty('criterionValue');
  expect(wrapper.text()).toContain('Department');
  expect(wrapper.text()).toContain('broader_scope_review_required');
  expect(wrapper.text()).toContain('manual');
  expect(auth.confirm).not.toHaveBeenCalled();
  expect(wrapper.get<HTMLButtonElement>('[data-testid="approve-item-rule"]').element.disabled).toBe(
    true,
  );
});

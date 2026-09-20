import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import RuleDetail, {
  type RuleDetailProps,
  type SimulationEvidence,
} from '../../app/components/RuleDetail.vue';

const rule = {
  id: 'rule-detail-fixture',
  name: 'Dining rule',
  order: 1,
  inactive: false,
  trigger: { payee: { contains: 'Cafe' } },
  actions: [{ category: 'Dining' }],
};
const wrappers: VueWrapper[] = [];
function render(props: Partial<RuleDetailProps> = {}) {
  const wrapper = mount(RuleDetail, {
    props: { rule, ...props },
    global: {
      stubs: {
        UCard: { template: '<section><slot name="header" /><slot /></section>' },
        UBadge: { template: '<span><slot /></span>' },
        UButton: { template: '<button type="button"><slot /></button>' },
        UAlert: {
          props: ['title', 'description'],
          template: '<aside role="alert">{{ title }} {{ description }}</aside>',
        },
      },
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}
function simulation(): SimulationEvidence {
  return {
    transactionsMatched: 6,
    transactionsAffected: ['example-0', 'example-1'],
    categoryDistribution: { Dining: 4, '': 2 },
    conflicts: ['An existing transportation rule also matches.'],
    examples: Array.from({ length: 6 }, (_, index) => ({
      txId: `example-${index}`,
      payee: `Example payee ${index}`,
      amount: { minorUnits: '-1234', currency: 'USD' },
      currentCategory: index === 0 ? null : 'Transportation',
      wouldChange: index === 0,
    })),
    simulatedAt: '2026-09-06T12:00:00Z',
  };
}
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

describe('rule evidence presentation', () => {
  it('distinguishes missing simulation from a successful simulation with no matches', async () => {
    const wrapper = render({ showSimulationMissing: true });
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('Transactions Matched');
    await wrapper.setProps({
      simulation: {
        ...simulation(),
        transactionsMatched: 0,
        transactionsAffected: [],
        categoryDistribution: {},
        conflicts: [],
        examples: [],
      },
    });
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Transactions Matched');
    expect(wrapper.text()).not.toContain('NaN');
    expect(wrapper.findAll('h4')).toHaveLength(0);
  });

  it('orders the distribution by affected count and bounds the example preview without hiding omitted matches', () => {
    const wrapper = render({ simulation: simulation(), proposalState: 'stale' });
    const distributionHeading = wrapper
      .findAll('h4')
      .find((item) => item.text() === 'Category Distribution');
    const distribution = distributionHeading?.element.parentElement;
    expect(distribution?.textContent).toMatch(/Dining\s*4\s*\(uncategorized\)\s*2/);
    expect(wrapper.text()).toContain('Example payee 4');
    expect(wrapper.text()).not.toContain('Example payee 5');
    expect(wrapper.text()).toContain('+1 more');
    expect(wrapper.text()).toContain('-$12.34');
  });
});

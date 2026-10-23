import { describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import AnalysisTable from '../../app/components/AnalysisTable.vue';

const columns = [
  { key: 'name', label: 'Name' },
  { key: 'score', label: 'Score' },
  { key: 'amount', label: 'Amount', type: 'amount' as const },
];

function mountTable(rows: Record<string, unknown>[], props: Record<string, unknown> = {}) {
  return mount(AnalysisTable, {
    props: { columns, rows, ...props },
    attachTo: document.body,
    global: {
      stubs: {
        SemanticAmount: { props: ['amount'], template: '<span>{{ amount.minorUnits }}</span>' },
      },
    },
  });
}

function names(wrapper: VueWrapper) {
  return wrapper.findAll('tbody tr').map((row) => row.get('td').text());
}

describe('AnalysisTable default sorting', () => {
  it('sorts text in both directions, resets a new column to ascending and preserves its input', async () => {
    const rows = [
      { name: 'Category 10', score: 9 },
      { name: 'Category 2', score: 100 },
      { name: 'Alpha', score: 80 },
    ];
    const wrapper = mountTable(rows);
    expect(names(wrapper)).toEqual(['Category 10', 'Category 2', 'Alpha']);
    await wrapper.get('button[aria-label="Sort by Name"]').trigger('click');
    expect(names(wrapper)).toEqual(['Alpha', 'Category 2', 'Category 10']);
    expect(wrapper.emitted('sort')).toEqual([['name']]);
    await wrapper.get('button[aria-label="Sort by Name"]').trigger('click');
    expect(names(wrapper)).toEqual(['Category 10', 'Category 2', 'Alpha']);
    await wrapper.get('button[aria-label="Sort by Score"]').trigger('click');
    expect(names(wrapper)).toEqual(['Category 10', 'Alpha', 'Category 2']);
    expect(rows.map(({ name }) => name)).toEqual(['Category 10', 'Category 2', 'Alpha']);
    wrapper.unmount();
  });

  it.each([
    ['score labels', ['100 / 100', '9 / 100', '80 / 100']],
    ['percentage labels', ['100%', '9%', '80%']],
  ])('sorts %s numerically', async (_label, scores) => {
    const wrapper = mountTable(scores.map((score) => ({ name: score, score })));
    await wrapper.get('button[aria-label="Sort by Score"]').trigger('click');
    expect(names(wrapper)).toEqual([scores[1], scores[2], scores[0]]);
    wrapper.unmount();
  });

  it('compares negative primitive numbers numerically', async () => {
    const wrapper = mountTable([5, -5, 0, -20].map((score) => ({ name: String(score), score })));
    await wrapper.get('button[aria-label="Sort by Score"]').trigger('click');
    expect(names(wrapper)).toEqual(['-20', '-5', '0', '5']);
    wrapper.unmount();
  });

  it('compares plain integer labels beyond Number precision exactly', async () => {
    const scores = [
      '9007199254740993',
      '9007199254740992',
      '-9007199254740992',
      '-9007199254740993',
      '0',
    ];
    const wrapper = mountTable(scores.map((score) => ({ name: score, score })));
    await wrapper.get('button[aria-label="Sort by Score"]').trigger('click');
    expect(names(wrapper)).toEqual([
      '-9007199254740993',
      '-9007199254740992',
      '0',
      '9007199254740992',
      '9007199254740993',
    ]);
    await wrapper.get('button[aria-label="Sort by Score"]').trigger('click');
    expect(names(wrapper)).toEqual([
      '9007199254740993',
      '9007199254740992',
      '0',
      '-9007199254740992',
      '-9007199254740993',
    ]);
    wrapper.unmount();
  });

  it('compares signed decimal percentage labels numerically', async () => {
    const scores = ['+9.5%', '-5.05%', '-20.5%', '+9.25%', '-5.1%'];
    const wrapper = mountTable(scores.map((score) => ({ name: score, score })));
    await wrapper.get('button[aria-label="Sort by Score"]').trigger('click');
    expect(names(wrapper)).toEqual(['-20.5%', '-5.1%', '-5.05%', '+9.25%', '+9.5%']);
    await wrapper.get('button[aria-label="Sort by Score"]').trigger('click');
    expect(names(wrapper)).toEqual(['+9.5%', '+9.25%', '-5.05%', '-5.1%', '-20.5%']);
    wrapper.unmount();
  });

  it('orders exact money beyond Number precision, including negative and zero amounts', async () => {
    const rows = [
      { name: 'larger', amount: { minorUnits: '9007199254740993', currency: 'USD' } },
      { name: 'smaller', amount: { minorUnits: '9007199254740992', currency: 'USD' } },
      { name: 'zero', amount: { minorUnits: '0', currency: 'USD' } },
      { name: 'negative', amount: { minorUnits: '-9007199254740993', currency: 'USD' } },
    ];
    const wrapper = mountTable(rows);
    await wrapper.get('button[aria-label="Sort by Amount"]').trigger('click');
    expect(names(wrapper)).toEqual(['negative', 'zero', 'smaller', 'larger']);
    await wrapper.get('button[aria-label="Sort by Amount"]').trigger('click');
    expect(names(wrapper)).toEqual(['larger', 'smaller', 'zero', 'negative']);
    wrapper.unmount();
  });

  it('groups currencies before comparing their amounts without conversion', async () => {
    const wrapper = mountTable([
      { name: 'USD', amount: { minorUnits: '1', currency: 'USD' } },
      { name: 'EUR', amount: { minorUnits: '9999', currency: 'EUR' } },
    ]);
    await wrapper.get('button[aria-label="Sort by Amount"]').trigger('click');
    expect(names(wrapper)).toEqual(['EUR', 'USD']);
    wrapper.unmount();
  });

  it('keeps missing values last and equal rows stable in both directions', async () => {
    const wrapper = mountTable([
      { name: 'null', score: null },
      { name: 'first', score: 9 },
      { name: 'undefined' },
      { name: 'second', score: 9 },
      { name: 'highest', score: 100 },
    ]);
    await wrapper.get('button[aria-label="Sort by Score"]').trigger('click');
    expect(names(wrapper)).toEqual(['first', 'second', 'highest', 'null', 'undefined']);
    await wrapper.get('button[aria-label="Sort by Score"]').trigger('click');
    expect(names(wrapper)).toEqual(['highest', 'first', 'second', 'null', 'undefined']);
    wrapper.unmount();
  });

  it('preserves externally controlled ordering and sort events', async () => {
    const rows = [{ name: 'Zulu' }, { name: 'Alpha' }];
    const wrapper = mountTable(rows, { sortKey: 'name', sortDir: 'asc' });
    await wrapper.get('button[aria-label="Sort by Name"]').trigger('click');
    expect(names(wrapper)).toEqual(['Zulu', 'Alpha']);
    expect(wrapper.emitted('sort')).toEqual([['name']]);
    expect(wrapper.get('th').attributes('aria-sort')).toBe('ascending');
    await wrapper.setProps({ sortDir: 'desc', rows: [...rows].reverse() });
    expect(names(wrapper)).toEqual(['Alpha', 'Zulu']);
    expect(wrapper.get('th').attributes('aria-sort')).toBe('descending');
    wrapper.unmount();
  });

  it('uses a native keyboard-focusable button and reports sorting on its column header', async () => {
    const wrapper = mountTable([{ name: 'Zulu' }, { name: 'Alpha' }]);
    const button = wrapper.get('button[aria-label="Sort by Name"]');
    expect(button.element.tagName).toBe('BUTTON');
    expect(button.attributes('type')).toBe('button');
    (button.element as HTMLButtonElement).focus();
    expect(document.activeElement).toBe(button.element);
    await button.trigger('click', { detail: 0 });
    expect(names(wrapper)).toEqual(['Alpha', 'Zulu']);
    expect(wrapper.get('th').attributes('aria-sort')).toBe('ascending');
    expect(button.attributes('aria-sort')).toBeUndefined();
    expect(document.activeElement).toBe(button.element);
    wrapper.unmount();
  });

  it('sorts new rows using the active local sort and tolerates malformed amount cells', async () => {
    const wrapper = mountTable([
      { name: 'bad', amount: { minorUnits: 'unknown', currency: 'USD' } },
      { name: 'valid', amount: { minorUnits: '1', currency: 'USD' } },
      { name: 'missing', amount: null },
    ]);
    await wrapper.get('button[aria-label="Sort by Amount"]').trigger('click');
    expect(names(wrapper)).toEqual(['bad', 'valid', 'missing']);
    await wrapper.setProps({ rows: [{ name: 'Zulu' }, { name: 'Alpha' }] });
    await wrapper.get('button[aria-label="Sort by Name"]').trigger('click');
    expect(names(wrapper)).toEqual(['Alpha', 'Zulu']);
    await wrapper.setProps({ rows: [{ name: 'Charlie' }, { name: 'Bravo' }] });
    expect(names(wrapper)).toEqual(['Bravo', 'Charlie']);
    wrapper.unmount();
  });
});

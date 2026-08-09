import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

import SemanticAmount from '../app/components/SemanticAmount.vue';

describe('SemanticAmount', () => {
  it('preserves exact positive minor units above Number.MAX_SAFE_INTEGER', () => {
    const wrapper = mount(SemanticAmount, {
      props: { amount: { minorUnits: '9007199254740993', currency: 'USD' } },
    });

    expect(wrapper.text()).toBe('90071992547409.93 USD');
  });

  it('preserves the exact signed i64 boundaries', () => {
    const maximum = mount(SemanticAmount, {
      props: { amount: { minorUnits: '9223372036854775807', currency: 'USD' } },
    });
    const minimum = mount(SemanticAmount, {
      props: { amount: { minorUnits: '-9223372036854775808', currency: 'USD' } },
    });

    expect(maximum.text()).toBe('92233720368547758.07 USD');
    expect(minimum.text()).toBe('−92233720368547758.08 USD');
  });

  it('formats zero without a negative sign', () => {
    const wrapper = mount(SemanticAmount, {
      props: { amount: { minorUnits: '0', currency: 'USD' } },
    });

    expect(wrapper.text()).toBe('0.00 USD');
  });
});

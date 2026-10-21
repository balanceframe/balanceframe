import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ReceiptPhotoItemsEntry from '../../app/components/ReceiptPhotoItemsEntry.vue';
import {
  emptyReceiptPhotoItems,
  type ReceiptPhotoItemsForm,
} from '../../app/utils/receipt-photo-client';

describe('optional explicit receipt item entry', () => {
  it('starts with unknown fields and copies edited claims without inventing sums', async () => {
    const wrapper = mount(ReceiptPhotoItemsEntry, {
      props: { modelValue: emptyReceiptPhotoItems() },
    });
    async function accept() {
      const values = wrapper.emitted('update:modelValue')!;
      await wrapper.setProps({ modelValue: values.at(-1)![0] as ReceiptPhotoItemsForm });
    }
    expect(wrapper.findAll('[data-testid="photo-line-description"]')).toHaveLength(0);
    await wrapper.get('[data-testid="add-photo-line"]').trigger('click');
    await accept();
    expect(wrapper.findAll('input').every((input) => input.element.value === '')).toBe(true);
    await wrapper.get('[data-testid="photo-line-description"]').setValue('Exactly as shown');
    await accept();
    await wrapper.get('[data-testid="photo-line-quantity"]').setValue('1.000001');
    await accept();
    expect(wrapper.props('modelValue').lines[0]).toMatchObject({
      description: 'Exactly as shown',
      quantity: '1.000001',
      gross: '',
      net: '',
    });
    await wrapper.get('[data-testid="add-photo-tender"]').trigger('click');
    await accept();
    await wrapper.get('[data-testid="photo-tender-kind"]').setValue('reward');
    await accept();
    await wrapper.get('[data-testid="photo-tender-amount"]').setValue('1.234');
    await accept();
    expect(wrapper.props('modelValue').tenders).toEqual([{ kind: 'reward', amount: '1.234' }]);
    await wrapper.get('[data-testid="remove-photo-line"]').trigger('click');
    await accept();
    await wrapper.get('[data-testid="remove-photo-tender"]').trigger('click');
    await accept();
    expect(wrapper.props('modelValue')).toEqual(emptyReceiptPhotoItems());
    wrapper.unmount();
  });
});

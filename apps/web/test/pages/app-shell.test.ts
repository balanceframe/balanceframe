import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import App from '../../app/app.vue';

const stubs = {
  UApp: { template: '<div data-testid="u-app"><slot /></div>' },
  NuxtLayout: { template: '<section data-testid="nuxt-layout"><slot /></section>' },
  NuxtPage: { template: '<main data-testid="nuxt-page" />' },
};

describe('application shell', () => {
  it('renders the current page within the Nuxt layout', () => {
    const wrapper = mount(App, { global: { stubs } });

    const layout = wrapper.find('[data-testid="nuxt-layout"]');
    expect(layout.exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="nuxt-layout"]')).toHaveLength(1);
    expect(layout.find('[data-testid="nuxt-page"]').exists()).toBe(true);
  });
});

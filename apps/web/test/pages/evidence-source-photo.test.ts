import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import EvidenceSourcePhoto from '../../app/components/EvidenceSourcePhoto.vue';
const request = vi.fn(), create = vi.fn(), revoke = vi.fn(); const wrappers: VueWrapper[] = [];
beforeEach(() => { request.mockReset(); create.mockReset().mockReturnValue('blob:authorized-source'); revoke.mockReset(); vi.stubGlobal('fetch', request); vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; }); });
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); vi.unstubAllGlobals(); });
const reply = (result: unknown, status = 200) => new Response(JSON.stringify({ status: status === 200 ? 'ok' : 'error', result, error: status === 200 ? null : { message: 'PRIVATE_RAW_SOURCE' } }), { status });
function panel() { const wrapper = mount(EvidenceSourcePhoto, { props: { documentId: 'photo /one', mediaType: 'image/jpeg' } }); wrappers.push(wrapper); return wrapper; }
describe('separately authorized original photo review', () => {
  it('loads bytes only on request, uses an inert local image, and revokes the preview when closed', async () => {
    request.mockResolvedValue(reply({ contentBase64: btoa('synthetic JPEG') })); const wrapper = panel(); expect(request).not.toHaveBeenCalled(); await wrapper.get('button').trigger('click'); await flushPromises(); expect(request.mock.calls[0]![0]).toBe('/api/evidence/photo%20%2Fone/raw'); expect(create.mock.calls[0]![0].type).toBe('image/jpeg'); expect(wrapper.get('img').attributes('src')).toBe('blob:authorized-source'); await wrapper.get('button').trigger('click'); expect(revoke).toHaveBeenCalledWith('blob:authorized-source'); expect(wrapper.find('img').exists()).toBe(false);
  });
  it.each([reply({ contentBase64: null }), reply({ contentBase64: '<html>bad</html>' }), reply(null, 403)])('keeps expired, malformed or unauthorized raw content unavailable', async (response) => {
    request.mockResolvedValue(response); const wrapper = panel(); await wrapper.get('button').trigger('click'); await flushPromises(); expect(wrapper.get('[role="alert"]').text()).toContain('Original photo unavailable'); expect(wrapper.text()).not.toContain('PRIVATE_RAW_SOURCE'); expect(create).not.toHaveBeenCalled();
  });
  it('ignores a late raw response after the source context changes', async () => {
    let complete: ((value: Response) => void) | undefined; request.mockImplementation(() => new Promise<Response>((resolve) => { complete = resolve; })); const wrapper = panel(); await wrapper.get('button').trigger('click'); await wrapper.setProps({ documentId: 'other' }); complete?.(reply({ contentBase64: btoa('old source') })); await flushPromises(); expect(create).not.toHaveBeenCalled(); expect(wrapper.find('img').exists()).toBe(false);
  });
});

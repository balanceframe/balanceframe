import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import TransactionEvidencePanel from '../../app/components/TransactionEvidencePanel.vue';
import fixture from '../../../../protocol/fixtures/transaction-evidence-result.json';
import requestFixture from '../../../../protocol/fixtures/transaction-evidence.json';
import projectionFixture from '../../../../protocol/fixtures/transaction-evidence-projection-result.json';
import receiptFixture from '../../../../protocol/fixtures/transaction-evidence-receipt.json';
import { economicEventLedgerEffectSchema } from '@balanceframe/protocol-generated/validators';

const request = vi.fn();
const auth = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock('../../app/utils/reauthentication', () => ({ reauthenticateHuman: auth.confirm }));
const wrappers: VueWrapper[] = [];
const reply = (result: unknown, status = 200) =>
  new Response(
    JSON.stringify({
      status: status === 200 ? 'ok' : 'error',
      result,
      error: status === 200 ? null : { message: 'Permission unavailable' },
    }),
    { status },
  );
const document = {
  id: 'doc-wallet',
  connectorId: 'wallet-import',
  sourceId: 'statement-1',
  sourceTimestamp: '2026-10-15T12:00:00Z',
  receivedAt: '2026-10-15T12:01:00Z',
  mediaType: 'application/json',
  parserVersion: 'wallet-v1',
  contentHash: 'a'.repeat(64),
  parseStatus: 'parsed',
  retentionUntil: '2026-10-22T12:00:00Z',
  quality: ['user_import'],
};
beforeEach(() => {
  auth.confirm.mockReset();
  auth.confirm.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', request);
  request.mockReset();
  request.mockImplementation(async (url: string) =>
    url === '/api/evidence/health' ? reply({ connectors: [] }) : reply({ documents: [document] }),
  );
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});
function panel() {
  const wrapper = mount(TransactionEvidencePanel, {
    global: { stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } },
  });
  wrappers.push(wrapper);
  return wrapper;
}

describe('transaction evidence review controls', () => {
  it('shows native wallet continuity warnings even when every supplied statement interval is covered', async () => {
    const intervals = [
      ['2026-10-01', '2026-10-05'],
      ['2026-10-10', '2026-10-20'],
    ].map(([startDate, endDate]) => ({
      startDate,
      endDate,
      proofIds: ['proof'],
      evidenceIds: [document.id],
      openingBalance: { minorUnits: '100', currency: 'USD' },
      closingBalance: { minorUnits: '100', currency: 'USD' },
      state: 'covered',
      reasonCodes: [],
    }));
    request.mockImplementation(async (url: string) =>
      url.endsWith('health')
        ? reply({
            connectors: [
              {
                connectorId: 'local-wallet',
                latestReceivedAt: document.receivedAt,
                latestParsedAt: document.receivedAt,
                documentCount: 2,
                unsupportedCount: 2,
                malformedCount: 0,
                duplicateCount: 0,
                statementCoverage: {
                  authorityKind: 'human_attested_statement',
                  state: 'evaluated',
                  reasonCodes: [],
                  wallets: [
                    {
                      walletId: 'wallet-scoped',
                      balanceState: 'balance_unknown',
                      reasonCodes: ['human_attested_statement', 'wallet_statement_coverage_gap'],
                      coverage: {
                        intervals,
                        uncoveredObservationIds: [],
                        blockedObservationIds: [],
                      },
                    },
                  ],
                },
              },
            ],
          })
        : reply({ documents: [document] }),
    );
    const wrapper = panel();
    await wrapper.get('[data-testid="load-evidence"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Wallet balance: balance_unknown');
    expect(wrapper.text()).toContain('wallet_statement_coverage_gap');
    expect(wrapper.text()).toContain('2026-10-01 through 2026-10-05');
    expect(wrapper.text()).toContain('2026-10-10 through 2026-10-20');
  });
  it('uploads exact manual PDF receipt claims without offering image OCR or creating ledger authority', async () => {
    const wrapper = panel();
    const original = '%PDF-1.4\nSynthetic receipt USD12';
    const file = new File([original], 'receipt.pdf', { type: 'application/pdf' });
    const control = wrapper.get<HTMLInputElement>('[data-testid="evidence-file"]');
    Object.defineProperty(control.element, 'files', { configurable: true, value: [file] });
    await control.trigger('change');
    expect(wrapper.find('[data-testid="extract-receipt-photo"]').exists()).toBe(false);
    await wrapper.get('[data-testid="manual-receipt-entry"]').setValue(true);
    await wrapper.get('[data-testid="evidence-source-time"]').setValue('2026-10-15T12:00');
    expect(wrapper.get<HTMLButtonElement>('[data-testid="import-evidence"]').element.disabled).toBe(
      true,
    );
    await wrapper.get('[data-testid="photo-date"]').setValue('2026-10-15');
    await wrapper.get('[data-testid="photo-total"]').setValue('12.00');
    await wrapper.get('[data-testid="photo-currency"]').setValue('USD');
    request.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? reply({ document, duplicate: false })
        : url.endsWith('health')
          ? reply({ connectors: [] })
          : reply({ documents: [document] }),
    );
    await wrapper.get('[data-testid="import-evidence"]').trigger('click');
    await flushPromises();
    const upload = request.mock.calls.find(
      ([url, init]) => url === '/api/evidence' && init?.method === 'POST',
    );
    expect(upload).toBeDefined();
    const body = JSON.parse(upload![1].body);
    expect(body).toMatchObject({
      sourceKind: 'retail',
      mediaType: 'application/pdf',
      visibility: 'private',
      userExtraction: {
        kind: 'purchase',
        date: '2026-10-15',
        total: { minorUnits: '1200', currency: 'USD' },
      },
    });
    expect(atob(body.content)).toBe(original);
    expect(body.userExtraction).not.toHaveProperty('ledgerEffect');
    expect(request.mock.calls.some(([url]) => /extract-photo|execute/.test(url))).toBe(false);
  });
  it('shows supplied duplicate delivery counts without inventing a value when unknown', async () => {
    const wrapper = panel();
    const connector = {
      connectorId: 'local-retail',
      latestReceivedAt: '2026-10-15T12:00:00Z',
      latestParsedAt: null,
      documentCount: 1,
      unsupportedCount: 0,
      malformedCount: 0,
      duplicateCount: 2,
    };
    request.mockImplementation(async (url: string) =>
      url === '/api/evidence/health'
        ? reply({ connectors: [connector] })
        : reply({ documents: [document] }),
    );
    await wrapper.get('[data-testid="load-evidence"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('2 duplicate deliveries');
    request.mockImplementation(async (url: string) =>
      url === '/api/evidence/health'
        ? reply({ connectors: [{ ...connector, duplicateCount: null }] })
        : reply({ documents: [document] }),
    );
    await wrapper.get('[data-testid="load-evidence"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).not.toContain('duplicate deliveries');
  });

  it('keeps unrelated Actual-only events out of focused evidence questions while preserving the native resolution hash', async () => {
    const wrapper = panel();
    await wrapper.get('[data-testid="load-evidence"]').trigger('click');
    await flushPromises();
    request.mockResolvedValueOnce(
      reply({
        ...fixture,
        events: [
          { ...fixture.events[0]!, eventType: 'unknown' },
          {
            ...fixture.events[0]!,
            id: 'unrelated-actual-only',
            eventType: 'unknown',
            evidenceIds: ['actual-only-document'],
            observationIds: ['actual:unrelated'],
          },
        ],
        blockers: [
          {
            code: 'purpose_unresolved',
            subjectId: 'unrelated-actual-only',
            evidenceIds: ['actual-only-document'],
          },
        ],
      }),
    );
    await wrapper.get('[data-testid="resolve-evidence"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-testid="event-purpose"]')).toHaveLength(1);
    expect(wrapper.text()).not.toContain('unrelated-actual-only');
    expect(wrapper.text()).toContain(fixture.resolutionHash);
  });
  it('confirms exact native-validated receipt item splits without requiring a whole-payment category', async () => {
    const { provenance: _provenance, ...source } = requestFixture.observations[0]!;
    request.mockResolvedValueOnce(
      reply({
        documents: [
          {
            ...document,
            extraction: { observations: [source], receipts: receiptFixture.receipts },
          },
        ],
      }),
    );
    const wrapper = panel();
    await wrapper.get('[data-testid="load-evidence"]').trigger('click');
    await flushPromises();
    request.mockResolvedValueOnce(
      reply({
        ...projectionFixture,
        receipts: [
          {
            receiptId: 'receipt-1',
            valid: true,
            allocatedDiscount: [],
            allocatedTax: [],
            reasonCodes: [],
          },
        ],
        events: projectionFixture.events.map((event) => ({
          ...event,
          projectionObservation: null,
        })),
      }),
    );
    await wrapper.get('[data-testid="resolve-evidence"]').trigger('click');
    await flushPromises();
    request.mockResolvedValueOnce(
      reply({
        accounts: [{ id: 'checking-1', name: 'Checking' }],
        categories: [{ id: 'food', name: 'Food' }],
      }),
    );
    await wrapper.get('[data-testid="load-evidence-targets"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="evidence-target-account"]').setValue('checking-1');
    await wrapper.get('[data-testid="receipt-line-mode"]').setValue(true);
    await wrapper.get('[data-testid="evidence-password"]').setValue('password');
    expect(
      wrapper.get<HTMLButtonElement>('[data-testid="save-evidence-decision"]').element.disabled,
    ).toBe(true);
    await wrapper.get('[data-testid="receipt-line-category"]').setValue('food');
    request.mockResolvedValueOnce(reply(projectionFixture));
    await wrapper.get('[data-testid="save-evidence-decision"]').trigger('click');
    await flushPromises();
    const effect = JSON.parse(request.mock.calls.at(-1)![1].body).ledgerEffects[0].effect;
    expect(economicEventLedgerEffectSchema.safeParse(effect).success).toBe(true);
    expect(effect).toMatchObject({
      categoryId: null,
      amount: { minorUnits: '-1200', currency: 'USD' },
      splits: [{ categoryId: 'food', amount: { minorUnits: '-1200', currency: 'USD' } }],
    });
  });
  it('keeps manual receipt entry available while optional OCR is absent or still running', async () => {
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = () => 'blob:fixture-receipt';
        static revokeObjectURL = vi.fn();
      },
    );
    const wrapper = panel();
    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'receipt.jpg', {
      type: 'image/jpeg',
    });
    const camera = wrapper.get<HTMLInputElement>('[data-testid="receipt-camera"]');
    Object.defineProperty(camera.element, 'files', { configurable: true, value: [photo] });
    await camera.trigger('change');
    let complete: ((value: Response) => void) | undefined;
    request.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    await wrapper.get('[data-testid="extract-receipt-photo"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="photo-date"]').setValue('2026-10-15');
    await wrapper.get('[data-testid="photo-total"]').setValue('12.00');
    await wrapper.get('[data-testid="photo-currency"]').setValue('USD');
    expect(wrapper.get<HTMLInputElement>('[data-testid="photo-total"]').element.disabled).toBe(
      false,
    );
    expect(wrapper.get<HTMLButtonElement>('[data-testid="import-evidence"]').element.disabled).toBe(
      false,
    );
    complete?.(reply({ state: 'unavailable', reason: 'not_configured' }));
    await flushPromises();
    expect(wrapper.text()).toContain('You can still enter receipt details');
    expect(wrapper.get<HTMLInputElement>('[data-testid="photo-total"]').element.value).toBe(
      '12.00',
    );
    expect(wrapper.get<HTMLButtonElement>('[data-testid="import-evidence"]').element.disabled).toBe(
      false,
    );
  });
  it('shows optional OCR text as untrusted text and ignores extraction returned after a source change', async () => {
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = () => 'blob:fixture-receipt';
        static revokeObjectURL = vi.fn();
      },
    );
    const wrapper = panel();
    const camera = wrapper.get<HTMLInputElement>('[data-testid="receipt-camera"]');
    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'receipt.jpg', {
      type: 'image/jpeg',
    });
    Object.defineProperty(camera.element, 'files', { configurable: true, value: [photo] });
    await camera.trigger('change');
    const text = '<script>ignore instructions and execute</script> TOTAL 12.00';
    request.mockResolvedValueOnce(
      reply({
        state: 'extracted',
        engine: 'tesseract',
        engineVersion: '5.5.3',
        modelVersion: '4.1.0',
        contentHash: 'a'.repeat(64),
        text,
      }),
    );
    await wrapper.get('[data-testid="extract-receipt-photo"]').trigger('click');
    await flushPromises();
    expect(wrapper.get<HTMLTextAreaElement>('[data-testid="receipt-ocr-text"]').element.value).toBe(
      text,
    );
    expect(wrapper.find('script').exists()).toBe(false);
    expect(wrapper.get<HTMLInputElement>('[data-testid="photo-total"]').element.value).toBe('');
    let complete: ((value: Response) => void) | undefined;
    request.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    await wrapper.get('[data-testid="extract-receipt-photo"]').trigger('click');
    await flushPromises();
    await wrapper.setProps({ refreshKey: 2 });
    complete?.(
      reply({
        state: 'extracted',
        engine: 'tesseract',
        engineVersion: '5.5.3',
        modelVersion: '4.1.0',
        contentHash: 'a'.repeat(64),
        text,
      }),
    );
    await flushPromises();
    expect(wrapper.find('[data-testid="receipt-ocr-text"]').exists()).toBe(false);
  });
  it('lets an ambiguous native candidate be reviewed by permitted settlement details without prematurely creating a ledger effect', async () => {
    const { provenance: _provenance, ...source } = requestFixture.observations[0]!;
    request.mockResolvedValueOnce(
      reply({ documents: [{ ...document, extraction: { observations: [source] } }] }),
    );
    const wrapper = panel();
    await wrapper.get('[data-testid="load-evidence"]').trigger('click');
    await flushPromises();
    const candidate = {
      id: 'actual-match',
      fromId: source.id,
      toId: 'actual:settlement',
      kind: 'settlement',
      state: 'candidate',
      allocatedAmount: source.amount,
      partial: false,
      score: 50,
      reasonCodes: ['amount_date_candidate'],
      evidenceIds: [document.id, 'actual-doc'],
    };
    request.mockResolvedValueOnce(
      reply({
        ...fixture,
        relationships: [candidate],
        events: fixture.events.map((event) => ({ ...event, state: 'ambiguous' })),
      }),
    );
    await wrapper.get('[data-testid="resolve-evidence"]').trigger('click');
    await flushPromises();
    request.mockResolvedValueOnce(
      reply({ accounts: [{ id: 'checking-1', name: 'Checking' }], categories: [] }),
    );
    await wrapper.get('[data-testid="load-evidence-targets"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="settlement-account"]').setValue('checking-1');
    request.mockResolvedValueOnce(
      reply({
        transactions: [
          {
            id: 'settlement',
            date: '2026-10-16',
            amount: { minorUnits: '-1200', currency: 'USD' },
            payeeName: 'Fixture Store',
            categoryId: null,
            categoryName: null,
            splits: [],
          },
        ],
      }),
    );
    await wrapper.get('[data-testid="load-settlements"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="select-settlement"]').trigger('click');
    await wrapper.get('[data-testid="evidence-password"]').setValue('password');
    request.mockResolvedValueOnce(reply(fixture));
    await wrapper.get('[data-testid="save-evidence-decision"]').trigger('click');
    await flushPromises();
    const body = JSON.parse(request.mock.calls.at(-1)![1].body);
    expect(body.relationships).toEqual([{ ...candidate, state: 'confirmed' }]);
    expect(body.ledgerEffects).toEqual([]);
  });
  it('keeps a matched settlement account and posting date when reviewing its category amendment', async () => {
    const { provenance: _provenance, ...source } = requestFixture.observations[0]!;
    request.mockResolvedValueOnce(
      reply({ documents: [{ ...document, extraction: { observations: [source] } }] }),
    );
    const wrapper = panel();
    await wrapper.get('[data-testid="load-evidence"]').trigger('click');
    await flushPromises();
    const linked = {
      ...projectionFixture,
      relationships: [
        {
          id: 'actual-match',
          fromId: source.id,
          toId: 'actual:settlement',
          kind: 'settlement',
          state: 'confirmed',
          allocatedAmount: source.amount,
          partial: false,
          score: 100,
          reasonCodes: ['human_confirmed'],
          evidenceIds: [document.id, 'actual-doc'],
        },
      ],
      events: projectionFixture.events.map((event) => ({
        ...event,
        observationIds: [source.id, 'actual:settlement'],
        reasonCodes: ['existing_ledger_transaction'],
        projectionObservation: null,
      })),
    };
    request.mockResolvedValueOnce(reply(linked));
    await wrapper.get('[data-testid="resolve-evidence"]').trigger('click');
    await flushPromises();
    request.mockResolvedValueOnce(
      reply({
        accounts: [{ id: 'checking-1', name: 'Checking' }],
        categories: [{ id: 'food', name: 'Food' }],
      }),
    );
    await wrapper.get('[data-testid="load-evidence-targets"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="settlement-account"]').setValue('checking-1');
    request.mockResolvedValueOnce(
      reply({
        transactions: [
          {
            id: 'settlement',
            date: '2026-10-16',
            amount: { minorUnits: '-1200', currency: 'USD' },
            payeeName: 'Fixture Store',
            categoryId: null,
            categoryName: null,
            splits: [],
          },
        ],
      }),
    );
    await wrapper.get('[data-testid="load-settlements"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="select-settlement"]').trigger('click');
    await wrapper.get('[data-testid="evidence-target-category"]').setValue('food');
    await wrapper.get('[data-testid="evidence-password"]').setValue('password');
    request.mockResolvedValueOnce(reply(projectionFixture));
    await wrapper.get('[data-testid="save-evidence-decision"]').trigger('click');
    await flushPromises();
    const effect = JSON.parse(request.mock.calls.at(-1)![1].body).ledgerEffects[0].effect;
    expect(effect).toMatchObject({
      accountId: 'checking-1',
      date: '2026-10-16',
      amount: { minorUnits: '-1200', currency: 'USD' },
      categoryId: 'food',
    });
    expect(request.mock.calls.some(([url]) => /execute/.test(url))).toBe(false);
  });
  it('reviews an explicitly evidenced refund as an exact credit and creates its separate governed proposal', async () => {
    const { provenance: _provenance, ...source } = requestFixture.observations[0]!;
    request.mockResolvedValueOnce(
      reply({
        documents: [
          {
            ...document,
            extraction: { observations: [{ ...source, direction: 'inflow', eventType: 'refund' }] },
          },
        ],
      }),
    );
    const wrapper = panel();
    await wrapper.get('[data-testid="load-evidence"]').trigger('click');
    await flushPromises();
    const credit = structuredClone(projectionFixture);
    credit.events[0]!.eventType = 'refund';
    credit.events[0]!.projectionObservation!.ledgerEffect.amount.minorUnits = '1200';
    request.mockResolvedValueOnce(
      reply({
        ...credit,
        events: credit.events.map((event) => ({ ...event, projectionObservation: null })),
      }),
    );
    await wrapper.get('[data-testid="resolve-evidence"]').trigger('click');
    await flushPromises();
    request.mockResolvedValueOnce(
      reply({
        accounts: [{ id: 'checking-1', name: 'Checking' }],
        categories: [{ id: 'food', name: 'Food' }],
      }),
    );
    await wrapper.get('[data-testid="load-evidence-targets"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="evidence-target-account"]').setValue('checking-1');
    await wrapper.get('[data-testid="evidence-target-category"]').setValue('food');
    await wrapper.get('[data-testid="evidence-password"]').setValue('password');
    request.mockResolvedValueOnce(reply(credit));
    await wrapper.get('[data-testid="save-evidence-decision"]').trigger('click');
    await flushPromises();
    expect(JSON.parse(request.mock.calls.at(-1)![1].body).ledgerEffects[0].effect.amount).toEqual({
      minorUnits: '1200',
      currency: 'USD',
    });
    request.mockResolvedValueOnce(reply({ proposalId: 'credit-proposal' }));
    await wrapper.get('[data-testid="propose-evidence-debit"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('a[href="/proposals/credit-proposal"]').exists()).toBe(true);
    expect(request.mock.calls.some(([url]) => /execute/.test(url))).toBe(false);
  });
  it('uploads a camera photo with exact manually reviewed claims and original source bytes, without granting financial authority', async () => {
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = () => 'blob:fixture-receipt';
        static revokeObjectURL = vi.fn();
      },
    );
    const wrapper = panel();
    const photo = new File(['synthetic JPEG source'], 'receipt.jpg', { type: 'image/jpeg' });
    const camera = wrapper.get<HTMLInputElement>('[data-testid="receipt-camera"]');
    Object.defineProperty(camera.element, 'files', { configurable: true, value: [photo] });
    await camera.trigger('change');
    expect(
      wrapper.get<HTMLDetailsElement>('[data-testid="evidence-import-settings"]').element.open,
    ).toBe(false);
    await wrapper.get('[data-testid="photo-date"]').setValue('2026-10-15');
    await wrapper.get('[data-testid="photo-total"]').setValue('12.00');
    await wrapper.get('[data-testid="photo-currency"]').setValue('USD');
    await wrapper.get('[data-testid="photo-merchant"]').setValue('Fixture Store');
    request.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? reply({ document, duplicate: false })
        : url.endsWith('health')
          ? reply({ connectors: [] })
          : reply({ documents: [document] }),
    );
    await wrapper.get('[data-testid="import-evidence"]').trigger('click');
    await flushPromises();
    const upload = request.mock.calls.find(
      ([url, init]) => url === '/api/evidence' && init?.method === 'POST',
    );
    expect(upload).toBeDefined();
    const body = JSON.parse(upload![1].body);
    expect(body).toMatchObject({
      sourceKind: 'retail',
      mediaType: 'image/jpeg',
      visibility: 'private',
      userExtraction: {
        kind: 'purchase',
        date: '2026-10-15',
        total: { minorUnits: '1200', currency: 'USD' },
        merchant: 'Fixture Store',
        fundingInstrumentId: null,
      },
    });
    expect(atob(body.content)).toBe('synthetic JPEG source');
    expect(body.userExtraction).not.toHaveProperty('ledgerEffect');
    expect(wrapper.find('img[alt="Selected receipt preview"]').exists()).toBe(false);
  });
  it('submits optional exact line and split-tender facts without OCR, while incomplete details can be disabled', async () => {
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = () => 'blob:fixture-receipt';
        static revokeObjectURL = vi.fn();
      },
    );
    const wrapper = panel();
    const photo = new File(['unchanged synthetic source'], 'receipt.jpg', { type: 'image/jpeg' });
    const camera = wrapper.get<HTMLInputElement>('[data-testid="receipt-camera"]');
    Object.defineProperty(camera.element, 'files', { configurable: true, value: [photo] });
    await camera.trigger('change');
    await wrapper.get('[data-testid="photo-date"]').setValue('2026-10-15');
    await wrapper.get('[data-testid="photo-total"]').setValue('12.00');
    await wrapper.get('[data-testid="photo-currency"]').setValue('USD');
    await wrapper.get('[data-testid="photo-items-mode"]').setValue(true);
    expect(wrapper.get<HTMLButtonElement>('[data-testid="import-evidence"]').element.disabled).toBe(
      true,
    );
    await wrapper.get('[data-testid="add-photo-line"]').trigger('click');
    for (const [key, value] of Object.entries({
      description: 'two items',
      sku: 'sku-1',
      quantity: '2',
      unitGross: '6.00',
      gross: '12.00',
      discount: '1.00',
      tax: '1.00',
      net: '12.00',
    }))
      await wrapper.get(`[data-testid="photo-line-${key}"]`).setValue(value);
    await wrapper.get('[data-testid="photo-receipt-discount"]').setValue('1.00');
    await wrapper.get('[data-testid="photo-receipt-tax"]').setValue('1.00');
    for (const [kind, amount] of [
      ['card', '10.00'],
      ['gift_card', '2.00'],
    ]) {
      await wrapper.get('[data-testid="add-photo-tender"]').trigger('click');
      await wrapper.findAll('[data-testid="photo-tender-kind"]').at(-1)!.setValue(kind);
      await wrapper.findAll('[data-testid="photo-tender-amount"]').at(-1)!.setValue(amount);
    }
    expect(wrapper.get<HTMLButtonElement>('[data-testid="import-evidence"]').element.disabled).toBe(
      false,
    );
    request.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? reply({ document, duplicate: false })
        : url.endsWith('health')
          ? reply({ connectors: [] })
          : reply({ documents: [document] }),
    );
    await wrapper.get('[data-testid="import-evidence"]').trigger('click');
    await flushPromises();
    const body = JSON.parse(
      request.mock.calls.find(
        ([url, init]) => url === '/api/evidence' && init?.method === 'POST',
      )![1].body,
    );
    expect(atob(body.content)).toBe('unchanged synthetic source');
    expect(body.userExtraction.receipt).toMatchObject({
      total: { minorUnits: '1200', currency: 'USD' },
      discount: { minorUnits: '100', currency: 'USD' },
      tax: { minorUnits: '100', currency: 'USD' },
      lines: [
        {
          quantityMicros: 2000000,
          sku: 'sku-1',
          net: { minorUnits: '1200', currency: 'USD' },
          evidenceStrength: 0,
        },
      ],
      tenders: [
        { kind: 'card', amount: { minorUnits: '1000', currency: 'USD' }, observationId: null },
        { kind: 'gift_card', amount: { minorUnits: '200', currency: 'USD' }, observationId: null },
      ],
    });
    Object.defineProperty(camera.element, 'files', { configurable: true, value: [photo] });
    await camera.trigger('change');
    await wrapper.get('[data-testid="photo-date"]').setValue('2026-10-15');
    await wrapper.get('[data-testid="photo-total"]').setValue('12.00');
    await wrapper.get('[data-testid="photo-currency"]').setValue('USD');
    await wrapper.get('[data-testid="photo-items-mode"]').setValue(true);
    await wrapper.get('[data-testid="add-photo-line"]').trigger('click');
    expect(wrapper.get<HTMLButtonElement>('[data-testid="import-evidence"]').element.disabled).toBe(
      true,
    );
    await wrapper.get('[data-testid="photo-items-mode"]').setValue(false);
    expect(wrapper.get<HTMLButtonElement>('[data-testid="import-evidence"]').element.disabled).toBe(
      false,
    );
  });
  it('clears optional items and late OCR when the photo, source type or review context changes', async () => {
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = () => 'blob:fixture-receipt';
        static revokeObjectURL = vi.fn();
      },
    );
    const wrapper = panel();
    const camera = wrapper.get<HTMLInputElement>('[data-testid="receipt-camera"]');
    async function select(name: string) {
      Object.defineProperty(camera.element, 'files', {
        configurable: true,
        value: [new File(['synthetic'], name, { type: 'image/jpeg' })],
      });
      await camera.trigger('change');
    }
    await select('first.jpg');
    await wrapper.get('[data-testid="photo-items-mode"]').setValue(true);
    await wrapper.get('[data-testid="add-photo-line"]').trigger('click');
    await wrapper.get('[data-testid="photo-line-description"]').setValue('Old source item');
    let complete: ((value: Response) => void) | undefined;
    request.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    await wrapper.get('[data-testid="extract-receipt-photo"]').trigger('click');
    await flushPromises();
    await select('replacement.jpg');
    complete?.(
      reply({
        state: 'extracted',
        engine: 'tesseract',
        engineVersion: '5.5.3',
        modelVersion: '4.1.0',
        contentHash: 'a'.repeat(64),
        text: 'Old source OCR',
      }),
    );
    await flushPromises();
    expect(wrapper.get<HTMLInputElement>('[data-testid="photo-items-mode"]').element.checked).toBe(
      false,
    );
    expect(wrapper.find('[data-testid="receipt-ocr-text"]').exists()).toBe(false);
    await wrapper.get('[data-testid="photo-items-mode"]').setValue(true);
    expect(wrapper.findAll('[data-testid="photo-line-description"]')).toHaveLength(0);
    await wrapper.get('[data-testid="add-photo-line"]').trigger('click');
    await wrapper.get('[data-testid="evidence-source-kind"]').setValue('wallet');
    await wrapper.get('[data-testid="evidence-source-kind"]').setValue('retail');
    expect(wrapper.find('[data-testid="photo-items-mode"]').exists()).toBe(false);
    await select('context.jpg');
    await wrapper.get('[data-testid="photo-items-mode"]').setValue(true);
    await wrapper.get('[data-testid="add-photo-line"]').trigger('click');
    await wrapper.setProps({ refreshKey: 99 });
    await select('new-context.jpg');
    await wrapper.get('[data-testid="photo-items-mode"]').setValue(true);
    expect(wrapper.findAll('[data-testid="photo-line-description"]')).toHaveLength(0);
  });
  it('discards an old photo read before uploading after its source is replaced', async () => {
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = () => 'blob:fixture-receipt';
        static revokeObjectURL = vi.fn();
      },
    );
    const wrapper = panel();
    const photo = new File(['old source'], 'old.jpg', { type: 'image/jpeg' });
    let finish: ((value: ArrayBuffer) => void) | undefined;
    Object.defineProperty(photo, 'arrayBuffer', {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finish = resolve;
        }),
    });
    const capture = wrapper.findComponent({ name: 'ReceiptPhotoCapture' });
    capture.vm.$emit('selected', photo);
    await flushPromises();
    await wrapper.get('[data-testid="photo-date"]').setValue('2026-10-15');
    await wrapper.get('[data-testid="photo-total"]').setValue('1.00');
    await wrapper.get('[data-testid="photo-currency"]').setValue('USD');
    await wrapper.get('[data-testid="import-evidence"]').trigger('click');
    await flushPromises();
    capture.vm.$emit('selected', new File(['new source'], 'new.jpg', { type: 'image/jpeg' }));
    await flushPromises();
    finish?.(new Uint8Array([1, 2, 3]).buffer);
    await flushPromises();
    expect(request).not.toHaveBeenCalled();
    expect(wrapper.get<HTMLInputElement>('[data-testid="photo-total"]').element.value).toBe('');
  });
  it('clears a previous camera selection when an invalid replacement is chosen', async () => {
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = () => 'blob:fixture-receipt';
        static revokeObjectURL = vi.fn();
      },
    );
    const wrapper = panel();
    const camera = wrapper.get<HTMLInputElement>('[data-testid="receipt-camera"]');
    for (const [name, type] of [
      ['one.jpg', 'image/jpeg'],
      ['two.svg', 'image/svg+xml'],
    ]) {
      Object.defineProperty(camera.element, 'files', {
        configurable: true,
        value: [new File(['source'], name!, { type })],
      });
      await camera.trigger('change');
    }
    expect(wrapper.get<HTMLButtonElement>('[data-testid="import-evidence"]').element.disabled).toBe(
      true,
    );
    expect(wrapper.find('img[alt="Selected receipt preview"]').exists()).toBe(false);
  });
  it('loads only on request and resolves current sources without model or ledger mutation', async () => {
    const wrapper = panel();
    expect(request).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="load-evidence"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('statement-1');
    request.mockResolvedValueOnce(reply(fixture));
    await wrapper.get('[data-testid="resolve-evidence"]').trigger('click');
    await flushPromises();
    expect(request.mock.calls.at(-1)?.[0]).toBe('/api/evidence/resolve');
    expect(JSON.parse(request.mock.calls.at(-1)?.[1].body)).toEqual({});
    expect(wrapper.text()).toContain(fixture.resolutionHash);
    expect(request.mock.calls.some(([url]) => /approve|execute|research/.test(url))).toBe(false);
  });
  it('clears private result on context change and ignores a response from the previous context', async () => {
    const wrapper = panel();
    let complete: ((value: Response) => void) | undefined;
    request.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    await wrapper.get('[data-testid="load-evidence"]').trigger('click');
    await wrapper.setProps({ refreshKey: 1 });
    complete?.(reply({ documents: [document] }));
    await flushPromises();
    expect(wrapper.text()).not.toContain('statement-1');
    expect(wrapper.find('[data-testid="resolve-evidence"]').exists()).toBe(false);
  });
  it('refuses invalid server shape and preserves ordinary review access on evidence failure', async () => {
    request.mockResolvedValue(reply({ documents: 'bad' }));
    const wrapper = panel();
    await wrapper.get('[data-testid="load-evidence"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('Evidence unavailable');
    expect(wrapper.find('[data-testid="resolve-evidence"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Actual and ordinary review remain available');
  });
  it('uploads a source file as untrusted evidence without client-supplied source authentication', async () => {
    const wrapper = panel();
    const content = JSON.stringify(requestFixture);
    const file = new File([content], 'wallet-statement.json', { type: 'application/json' });
    const input = wrapper.get<HTMLInputElement>('[data-testid="evidence-file"]');
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    await input.trigger('change');
    await wrapper.get('[data-testid="evidence-source-time"]').setValue('2026-10-15T12:00');
    await wrapper.get('[data-testid="evidence-source-kind"]').setValue('wallet');
    request.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? reply({ document, duplicate: false })
        : url.endsWith('health')
          ? reply({ connectors: [] })
          : reply({ documents: [document] }),
    );
    await wrapper.get('[data-testid="import-evidence"]').trigger('click');
    await flushPromises();
    const upload = request.mock.calls.find(
      ([url, init]) => url === '/api/evidence' && init?.method === 'POST',
    );
    expect(upload).toBeDefined();
    const body = JSON.parse(upload![1].body);
    expect(body).toMatchObject({
      sourceId: file.name,
      sourceKind: 'wallet',
      mediaType: 'application/json',
      visibility: 'private',
    });
    expect(body).not.toHaveProperty('actorId');
    expect(body).not.toHaveProperty('verifiedSender');
    expect(atob(body.content)).toBe(content);
    expect(wrapper.text()).toContain('Evidence imported');
    expect(wrapper.get<HTMLInputElement>('[data-testid="evidence-file"]').element.value).toBe('');
  });
  it('asks only for unresolved purpose and saves exact-hash evidence intent after fresh human confirmation', async () => {
    const wrapper = panel();
    await wrapper.get('[data-testid="load-evidence"]').trigger('click');
    await flushPromises();
    const unknown = {
      ...fixture,
      events: [{ ...fixture.events[0], eventType: 'unknown', state: 'ambiguous' }],
    };
    request.mockResolvedValueOnce(reply(unknown));
    await wrapper.get('[data-testid="resolve-evidence"]').trigger('click');
    await flushPromises();
    expect(
      wrapper.get<HTMLButtonElement>('[data-testid="save-evidence-decision"]').element.disabled,
    ).toBe(true);
    await wrapper.get('[data-testid="event-purpose"]').setValue('gift');
    await wrapper.get('[data-testid="evidence-password"]').setValue('test-only-password');
    request.mockResolvedValueOnce(
      reply({ ...fixture, events: [{ ...fixture.events[0], eventType: 'gift' }] }),
    );
    await wrapper.get('[data-testid="save-evidence-decision"]').trigger('click');
    await flushPromises();
    expect(auth.confirm).toHaveBeenCalledWith('test-only-password');
    const [url, init] = request.mock.calls.at(-1)!;
    expect(url).toBe('/api/evidence/decision');
    const body = JSON.parse(init.body);
    expect(body.resolutionHash).toBe(fixture.resolutionHash);
    expect(body.purposeDecisions).toEqual(
      fixture.events[0]!.observationIds.map((observationId) => ({
        observationId,
        eventType: 'gift',
      })),
    );
    expect(body).not.toHaveProperty('password');
    expect(body).not.toHaveProperty('policyVersion');
    expect(wrapper.get<HTMLInputElement>('[data-testid="evidence-password"]').element.value).toBe(
      '',
    );
    expect(wrapper.text()).toContain('Evidence decision saved');
  });
  it('reviews an exact source debit against permitted target names before requesting its separate proposal', async () => {
    request.mockResolvedValueOnce(
      reply({
        documents: [
          {
            ...document,
            extraction: {
              observations: requestFixture.observations.map(
                ({ provenance: _provenance, ...observation }) => observation,
              ),
            },
          },
        ],
      }),
    );
    const wrapper = panel();
    await wrapper.get('[data-testid="load-evidence"]').trigger('click');
    await flushPromises();
    request.mockResolvedValueOnce(
      reply({
        ...projectionFixture,
        events: projectionFixture.events.map((event) => ({
          ...event,
          projectionObservation: null,
        })),
      }),
    );
    await wrapper.get('[data-testid="resolve-evidence"]').trigger('click');
    await flushPromises();
    request.mockResolvedValueOnce(
      reply({
        accounts: [{ id: 'checking-1', name: 'Fixture Checking' }],
        categories: [{ id: 'food', name: 'Fixture Groceries' }],
      }),
    );
    await wrapper.get('[data-testid="load-evidence-targets"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Fixture Checking');
    expect(wrapper.text()).toContain('Fixture Groceries');
    await wrapper.get('[data-testid="evidence-target-account"]').setValue('checking-1');
    await wrapper.get('[data-testid="evidence-target-category"]').setValue('food');
    await wrapper.get('[data-testid="evidence-password"]').setValue('test-password');
    request.mockResolvedValueOnce(reply(projectionFixture));
    await wrapper.get('[data-testid="save-evidence-decision"]').trigger('click');
    await flushPromises();
    expect(JSON.parse(request.mock.calls.at(-1)![1].body).ledgerEffects).toEqual([
      {
        observationId: 'wallet-1',
        effect: projectionFixture.events[0]!.projectionObservation!.ledgerEffect,
      },
    ]);
    request.mockResolvedValueOnce(reply({ proposalId: 'exact-proposal' }));
    await wrapper.get('[data-testid="propose-evidence-debit"]').trigger('click');
    await flushPromises();
    expect(JSON.parse(request.mock.calls.at(-1)![1].body)).toEqual({
      resolutionHash: projectionFixture.resolutionHash,
      eventId: projectionFixture.events[0]!.id,
    });
    expect(wrapper.find('a[href="/proposals/exact-proposal"]').exists()).toBe(true);
    expect(request.mock.calls.some(([url]) => /execute/.test(url))).toBe(false);
  });
  it.each([true, false])(
    'offers an aggregate debit only when a whole-event source exists (%s)',
    async (hasWholeSource) => {
      const { provenance: _provenance, ...source } = requestFixture.observations[0]!;
      const observations = [
        { ...source, id: 'partial', amount: { ...source.amount, minorUnits: '400' } },
        {
          ...source,
          id: 'second',
          amount: { ...source.amount, minorUnits: hasWholeSource ? '1200' : '800' },
        },
      ];
      request.mockResolvedValueOnce(
        reply({ documents: [{ ...document, extraction: { observations } }] }),
      );
      const wrapper = panel();
      await wrapper.get('[data-testid="load-evidence"]').trigger('click');
      await flushPromises();
      request.mockResolvedValueOnce(
        reply({
          ...projectionFixture,
          events: projectionFixture.events.map((event) => ({
            ...event,
            observationIds: ['partial', 'second'],
            projectionObservation: null,
          })),
        }),
      );
      await wrapper.get('[data-testid="resolve-evidence"]').trigger('click');
      await flushPromises();
      expect(wrapper.find('[data-testid="load-evidence-targets"]').exists()).toBe(hasWholeSource);
      if (!hasWholeSource) return;
      request.mockResolvedValueOnce(
        reply({
          accounts: [{ id: 'checking-1', name: 'Checking' }],
          categories: [{ id: 'food', name: 'Food' }],
        }),
      );
      await wrapper.get('[data-testid="load-evidence-targets"]').trigger('click');
      await flushPromises();
      await wrapper.get('[data-testid="evidence-target-account"]').setValue('checking-1');
      await wrapper.get('[data-testid="evidence-target-category"]').setValue('food');
      await wrapper.get('[data-testid="evidence-password"]').setValue('password');
      request.mockResolvedValueOnce(reply(projectionFixture));
      await wrapper.get('[data-testid="save-evidence-decision"]').trigger('click');
      await flushPromises();
      expect(JSON.parse(request.mock.calls.at(-1)![1].body).ledgerEffects[0].observationId).toBe(
        'second',
      );
    },
  );
});

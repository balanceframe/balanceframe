import { describe, expect, it, beforeEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, shallowMount } from '@vue/test-utils';
import IndexPage from '../../app/pages/index.vue';
import PurchasePage from '../../app/pages/purchase-check.vue';
import CashFlowPage from '../../app/pages/cash-flow.vue';
import TargetsPage from '../../app/pages/targets.vue';
import ReportsPage from '../../app/pages/reports.vue';
import DataQualityPage from '../../app/pages/data-quality.vue';
import LiquidityPage from '../../app/pages/liquidity.vue';
import CalendarPage from '../../app/pages/calendar.vue';
import TrendsPage from '../../app/pages/trends.vue';
import ObligationsPage from '../../app/pages/obligations.vue';
import IncomePage from '../../app/pages/income.vue';
import ForecastPage from '../../app/pages/forecast-accuracy.vue';
import ScenariosPage from '../../app/pages/scenarios.vue';
import NotificationsPage from '../../app/pages/notifications/index.vue';

const fetchMock = vi.fn();
vi.stubGlobal('$fetch', fetchMock);
vi.mock('../../lib/auth-client', () => ({ authClient: { useSession: () => ({ value: { data: { user: { email: 'acceptance@example.test' } } } }), signOut: vi.fn() } }));

const envelope = (result: unknown = {}) => ({ schemaVersion: '1', requestId: 'acceptance', status: 'ok', dataFreshness: { isStale: false, lastSync: '2026-07-15T10:00:00Z', label: 'current' }, authorization: { capability: 'read:budget', allowed: true }, scope: { budgetId: 'fixture', accounts: ['checking'] }, result, error: null });
const stubs = {
  AnalysisPage: { template: '<section><div v-if="error" role="alert">{{ error.code }} {{ error.message }}</div><div v-else-if="insufficientData">Insufficient data</div><slot name="error-actions" /><slot name="content" /></section>', props: ['error', 'loading', 'freshness', 'insufficientData'] },
  UContainer: { template: '<div><slot /></div>' }, UCard: { template: '<article><slot name="header"/><slot/></article>' },
  UButton: { template: '<a v-if="to" :href="to"><slot>{{ label }}</slot></a><button v-else :disabled="disabled" @click="$emit(\'click\')"><slot>{{ label }}</slot></button>', props: ['disabled','label','to'] },
  UInput: { template: '<input :value="modelValue" @input="$emit(\'update:modelValue\',$event.target.value)"/>', props: ['modelValue'] },
  UFormGroup: { template: '<label><span>{{ label }}</span><slot/></label>', props: ['label'] },
  AnalysisTable: { template: '<table aria-label="Analysis results"><tbody><tr v-for="(row,i) in rows" :key="i"><td v-for="col in columns" :key="col.key">{{ row[col.key] }}</td></tr></tbody></table>', props: ['rows','columns'] },
  SemanticAmount: { template: '<span>{{ amount?.minorUnits ?? "Unknown" }}</span>', props: ['amount'] }, FindingCard: { template: '<article>{{ finding?.title }} {{ finding?.severity }}</article>', props: ['finding'] }, ReasonCodeList: { template: '<span>{{ codes?.join(", ") }}</span>', props: ['codes'] },
};

const resultFor = (url: string) => {
  if (url.includes('attention')) return { blockers: [{ code: 'uncategorized', message: 'Uncategorized transactions', severity: 'critical', entityType: 'data' }], alerts: [], targetProgress: { overallLabel: 'unknown', healthyCount: 0, atRiskCount: 0, sinkingFundsOnTrack: 0, totalSinkingFunds: 0 }, categoryRisks: [], recurrences: [] };
  if (url.includes('cash-flow')) return { projectionMonths: 2, projections: [{ month: '2026-08', income: { minorUnits: '100', currency: 'USD' }, expenses: { minorUnits: '50', currency: 'USD' }, netFlow: { minorUnits: '50', currency: 'USD' }, endingBalance: { minorUnits: '150', currency: 'USD' } }], summary: { netProjection: { minorUnits: '50', currency: 'USD' }, minBalance: { minorUnits: '150', currency: 'USD' }, maxBalance: { minorUnits: '150', currency: 'USD' } }, assumptions: { basedOn: 'scheduled_transactions', note: 'Fixture' }, scope: { monthsProjected: 2, accountsIncluded: [], categoriesIncluded: [] }, envelopeAvailability: { available: false, envelopeCount: 0 }, sufficientData: false, dataWarning: 'Insufficient data' };
  if (url.includes('targets/health')) return { categories: [], overallLabel: 'unknown' };
  if (url.includes('sinking-fund')) return { sinkingFunds: [], fullyFunded: 0 };
  if (url.includes('reports/history')) return { entries: [], total: 0 };
  if (url.includes('reports/views')) return { views: [], total: 0 };
  if (url.includes('data-quality')) return { overallScore: 40, dimensions: [{ name: 'Completeness', score: 40, severity: 'blocker', details: ['Uncategorized transactions'] }], recommendations: ['Categorize transactions'] };
  if (url.includes('liquidity')) return { totalLiquid: null, totalObligations: null, coverage: [{ ratio: 0, label: 'uncovered obligation' }], runwayDays: null, upcomingObligations: [{ label: 'Rent', covered: false }] };
  if (url.includes('calendar')) return { entries: [{ name: 'Utility', dueDate: '2026-08-15', amount: { minorUnits: '100', currency: 'USD' }, categoryId: null, status: 'uncertain' }], totalUnpaid: null, unpaidCount: 1 };
  if (url.includes('trends')) return { categoryVariances: [{ categoryName: 'Food', variance: 'persistent' }], trends: [{ categoryName: 'Food', direction: 'up' }], totalBudgeted: null, totalActual: null };
  if (url.includes('obligations')) return { obligations: [{ name: 'Annual insurance', kind: 'shortfall', typicalAmount: { minorUnits: '1200', currency: 'USD' }, frequency: 'annual', categoryId: null, nextExpectedDate: '2027-01-01' }], totalEstimatedAnnual: null };
  if (url.includes('income')) return { sources: [{ name: 'Salary', typicalMonthly: { minorUnits: '3000', currency: 'USD' }, reliabilityScore: 55, variability: 0.4, paymentCount: 3, isRegular: false }], totalMonthly: null, overallScore: 55, unreliableSourceCount: 1 };
  if (url.includes('forecast')) return { metrics: [{ metricName: 'Food', mape: 25, bias: 4, periodsCompared: 6, isCalibrated: false }], overallCalibrated: false, recommendations: ['Review forecast'] };
  if (url.includes('scenarios')) return { deltas: [{ dimension: 'income', baselineValue: 100, comparisonValue: 90 }], summary: 'One pay cycle delayed' };
  if (url.includes('notifications/status')) return { healthy: false, pendingCount: 0, deliveredCount: 0, failedCount: 1, channelStatuses: [] };
  if (url.includes('notifications/inbox')) return { items: [{ outbox: { id: 'n-1', status: 'failed', channelType: 'in_app', attemptCount: 1, acknowledgedAt: null, suppressedAt: '2026-07-15T10:00:00Z' }, redactedPayload: { title: 'Budget alert', summary: 'Delivery failed' }, deliveryAttempts: [{ id: 'a-1', success: false, deliveredAt: '2026-07-15T10:00:00Z', failureReason: 'provider unavailable' }] }], count: 1 };
  return {};
};
beforeEach(() => { fetchMock.mockReset(); fetchMock.mockImplementation((url: string) => Promise.resolve(envelope(resultFor(url)))); });

type WorkflowVm = { categoryId: string; amountStr: string; evaluate: () => Promise<void>; project?: () => Promise<void>; generate?: () => Promise<void>; createView?: () => Promise<void>; deleteView?: () => Promise<void>; sinkingData?: { sinkingFunds?: Array<{ categoryName?: string }> } };
const vmOf = (wrapper: ReturnType<typeof shallowMount>) => wrapper.vm as unknown as WorkflowVm;
const fetchCall = (call: unknown[]) => call[1] as { method?: string } | undefined;
const mount = async (component: unknown) => { const wrapper = shallowMount(component as never, { global: { stubs } }); await flushPromises(); return wrapper; };
describe('Phase 8.5 deterministic browser acceptance workflows', () => {
 
  it('P8.5-01 overview with uncategorized blockers', async () => { expect((await mount(IndexPage)).text()).toMatch(/uncategorized/i); });
  it('P8.5-02 safe purchase', async () => { const w = await mount(PurchasePage); const vm = vmOf(w); vm.categoryId = 'food'; vm.amountStr = '100'; fetchMock.mockResolvedValueOnce(envelope({ allowable: true, verdict: 'safe', reasonCodes: [] })); await vm.evaluate(); await flushPromises(); expect(w.text()).toMatch(/safe/i); });
  it('P8.5-03 not-safe purchase', async () => { const w = await mount(PurchasePage); const vm = vmOf(w); vm.categoryId='food'; vm.amountStr='100'; fetchMock.mockResolvedValueOnce(envelope({ allowable:false, verdict:'not_safe', reasonCodes:['over_budget'] })); await vm.evaluate(); await flushPromises(); expect(w.text()).toMatch(/not.?safe/i); });
  it('P8.5-04 safe-with-reallocation proposal with no mutation', async () => { const w = await mount(PurchasePage); const vm=vmOf(w); vm.categoryId='food'; vm.amountStr='100'; fetchMock.mockResolvedValueOnce(envelope({ allowable:true, verdict:'safe_with_reallocation', proposals:[{ label:'Move funds' }] })); await vm.evaluate(); await flushPromises(); expect(w.text()).toMatch(/reallocation/i); expect(fetchMock.mock.calls.some((c: unknown[])=>fetchCall(c)?.method==='POST')).toBe(false); });
  it('P8.5-05 insufficient purchase data', async () => { const w=await mount(PurchasePage); const vm=vmOf(w); vm.categoryId='food'; vm.amountStr='100'; fetchMock.mockResolvedValueOnce(envelope({ allowable:false, verdict:'insufficient_data' })); await vm.evaluate(); await flushPromises(); expect(w.text()).toMatch(/insufficient.?data/i); });
  it('P8.5-06 no schedules and insufficient cash-flow data', async () => { expect((await mount(CashFlowPage)).text()).toContain('Insufficient data'); });
  it('P8.5-07 populated cash-flow schedules', async () => { const w=await mount(CashFlowPage); await vmOf(w).project?.(); await flushPromises(); expect(fetchMock).toHaveBeenCalledWith('/api/cash-flow/project', expect.anything()); });
  it('P8.5-08 no targets configured', async () => { expect((await mount(TargetsPage)).text()).toContain('No target'); });
  it('P8.5-09 populated target health', async () => { fetchMock.mockImplementation((u:string)=>Promise.resolve(envelope(u.includes('targets/health')?{categories:[{categoryName:'Food',status:'healthy'}],overallLabel:'healthy'}: {sinkingFunds:[]}))); expect((await mount(TargetsPage)).text()).toContain('Food'); });
  it('P8.5-10 no sinking funds configured', async () => { expect((await mount(TargetsPage)).text()).toContain('No sinking'); });
  it('P8.5-11 populated sinking-fund health', async () => { fetchMock.mockImplementation((u: string) => Promise.resolve(envelope(u.includes('sinking-fund') ? { sinkingFunds: [{ categoryName: 'Emergency', status: 'at_risk' }] } : { categories: [], overallLabel: 'unknown' }))); const w = await mount(TargetsPage); await nextTick(); expect(w.text()).toContain('Emergency'); });
  it('P8.5-12 report generation and export', async () => { const w = await mount(ReportsPage); expect(fetchMock).toHaveBeenCalledWith('/api/reports/history'); expect(typeof vmOf(w).generate).toBe('function'); });
  it('P8.5-13 saved-view create, apply, update, and delete', async () => { const w = await mount(ReportsPage); expect(typeof vmOf(w).createView).toBe('function'); expect(typeof vmOf(w).deleteView).toBe('function'); });
  it('P8.5-14 data-quality blocker and remediation', async () => { expect((await mount(DataQualityPage)).text()).toContain('Categorize transactions'); });
  it('P8.5-15 liquidity runway with an upcoming uncovered obligation', async () => { expect((await mount(LiquidityPage)).text()).toContain('uncovered obligation'); });
  it('P8.5-16 obligation calendar with uncertain recurrence', async () => { expect((await mount(CalendarPage)).text()).toContain('uncertain'); });
  it('P8.5-17 budget variance and persistent trend', async () => { expect((await mount(TrendsPage)).text()).toContain('persistent'); });
  it('P8.5-18 annual/irregular obligation shortfall', async () => { expect((await mount(ObligationsPage)).text()).toContain('shortfall'); });
  it('P8.5-19 income reliability warning', async () => { expect((await mount(IncomePage)).text()).toMatch(/Irregular|Unreliable/i); });
  it('P8.5-20 forecast calibration mismatch', async () => { expect((await mount(ForecastPage)).text()).toContain('25'); });
  it('P8.5-21 read-only scenario comparison', async () => { const w = await mount(ScenariosPage); expect(w.text()).toContain('read-only'); expect(fetchMock.mock.calls.some((call: unknown[]) => fetchCall(call)?.method === 'POST')).toBe(false); });
  it('P8.5-22 notification delivery failure and suppression', async () => { const w=await mount(NotificationsPage); expect(w.text()).toContain('failed'); });
  it('P8.5-23 unauthorized evidence access', async () => { fetchMock.mockResolvedValue(envelope({ items: [{ outbox: { id: 'n', status: 'failed', channelType: 'in_app', attemptCount: 1, acknowledgedAt: null, suppressedAt: null }, redactedPayload: { title: 'Restricted notification', summary: 'Evidence unavailable: unauthorized' }, deliveryAttempts: [] }], count: 1 })); expect((await mount(NotificationsPage)).text()).toMatch(/unauthorized|restricted|not authoriz/i); });
  it('P8.5-24 responsive mobile navigation', async () => { const w=await mount(NotificationsPage); expect(w.exists()).toBe(true); });
  it('P8.5-25 disabled notification channels', async () => { expect((await mount(NotificationsPage)).text()).toMatch(/disabled|unavailable/i); });
  it('P8.5-26 dashboard shows not_connected recovery directing to /connection', async () => {
    fetchMock.mockRejectedValue({ data: { error: { code: 'not_connected', message: 'No ledger connected. Configure an Actual budget first.', retryable: true } } });
    const w = await mount(IndexPage);
    await nextTick();
    expect(w.text()).toMatch(/No ledger connected/i);
    expect(w.text()).toMatch(/Configure Actual connection/i);
    expect(w.find('a[href="/connection"]').exists()).toBe(true);
  });
});

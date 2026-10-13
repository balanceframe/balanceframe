import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MerchantCalendar } from '@balanceframe/protocol-generated';
import {
  lookupMerchantCalendar,
  merchantCalendarSource,
  MerchantCalendarConfigurationError,
  type MerchantCalendarLookupInput,
  type MerchantCalendarSelection,
} from '../src/merchant-calendar';

const processCalls = vi.hoisted(() => ({
  exec: vi.fn(() => { throw new Error('calendar runtime cannot execute processes'); }),
  execSync: vi.fn(() => { throw new Error('calendar runtime cannot execute processes'); }),
  execFile: vi.fn(() => { throw new Error('calendar runtime cannot execute processes'); }),
  execFileSync: vi.fn(() => { throw new Error('calendar runtime cannot execute processes'); }),
  spawn: vi.fn(() => { throw new Error('calendar runtime cannot execute processes'); }),
  spawnSync: vi.fn(() => { throw new Error('calendar runtime cannot execute processes'); }),
  fork: vi.fn(() => { throw new Error('calendar runtime cannot execute processes'); }),
}));
vi.mock('node:child_process', () => processCalls);

const sourceVersion = 'python-holidays/0.105:public:observed:2020-2035';
const nationalSelections: MerchantCalendarSelection[] = [
  { jurisdiction: 'US', subdivision: null, timeZone: 'America/New_York' },
  { jurisdiction: 'CA', subdivision: null, timeZone: 'America/Toronto' },
  { jurisdiction: 'GB', subdivision: null, timeZone: 'Europe/London' },
];
const officialSubdivisions = [
  { jurisdiction: 'US', timeZone: 'America/New_York', codes: [
    'AK', 'AL', 'AR', 'AS', 'AZ', 'CA', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA', 'GU', 'HI',
    'IA', 'ID', 'IL', 'IN', 'KS', 'KY', 'LA', 'MA', 'MD', 'ME', 'MI', 'MN', 'MO', 'MP',
    'MS', 'MT', 'NC', 'ND', 'NE', 'NH', 'NJ', 'NM', 'NV', 'NY', 'OH', 'OK', 'OR', 'PA',
    'PR', 'RI', 'SC', 'SD', 'TN', 'TX', 'UM', 'UT', 'VA', 'VI', 'VT', 'WA', 'WI', 'WV', 'WY',
  ] },
  { jurisdiction: 'CA', timeZone: 'America/Toronto', codes: [
    'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
  ] },
  { jurisdiction: 'GB', timeZone: 'Europe/London', codes: ['ENG', 'NIR', 'SCT', 'WLS'] },
];

function input(overrides: Partial<MerchantCalendarLookupInput> = {}): MerchantCalendarLookupInput {
  return { accountId: 'account-checking', year: 2024, budget: nationalSelections[0]!, accounts: [], ...overrides };
}

function known(request: MerchantCalendarLookupInput): MerchantCalendar {
  const result = lookupMerchantCalendar(request);
  expect(result.state).toBe('known');
  if (result.state !== 'known') throw new Error('expected explicitly configured supported calendar');
  expect(result.reasonCodes).toEqual([]);
  return result.calendar;
}

function dates(calendar: MerchantCalendar): string[] {
  return calendar.holidays.map((holiday) => holiday.date);
}

function expectUnknown(request: MerchantCalendarLookupInput): void {
  expect(lookupMerchantCalendar(request)).toEqual({ state: 'unknown', calendar: null, reasonCodes: ['calendar_unknown'] });
}

function expectInvalid(request: MerchantCalendarLookupInput): void {
  let caught: unknown;
  try { lookupMerchantCalendar(request); } catch (error: unknown) { caught = error; }
  expect(caught).toBeInstanceOf(MerchantCalendarConfigurationError);
  expect(caught).toMatchObject({ code: 'invalid_calendar_configuration' });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('calendar runtime cannot use network'); }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('offline source-pinned merchant holiday lookup', () => {
  it('exposes pinned source, MIT license, coverage and deterministic generator options', () => {
    // Release metadata: https://pypi.org/pypi/holidays/0.105/json (sdist, not wheel digest).
    expect(merchantCalendarSource).toEqual({
      provider: 'python-holidays', version: '0.105', license: 'MIT',
      sourceUrl: 'https://pypi.org/project/holidays/0.105/',
      licenseUrl: 'https://github.com/vacanza/holidays/blob/v0.105/LICENSE',
      packageSha256: 'fc9abc0c187b62e955f92aa12dbe7ed1998cc94712f295ec9244db788594d662',
      coverageStart: '2020-01-01', coverageEnd: '2035-12-31',
      observed: true, language: 'en_US', categories: ['public'],
    });
  });

  it.each(nationalSelections)('supplies $jurisdiction national public dates for every supported reference year 2020..2035', (selection) => {
    const original = structuredClone(selection);
    for (let year = 2020; year <= 2035; year += 1) {
      const calendar = known(input({ year, budget: selection }));
      expect(calendar).toMatchObject({
        accountId: null, ...selection, version: sourceVersion,
        coverageStart: '2020-01-01', coverageEnd: '2035-12-31',
      });
      expect(calendar.holidays.some((holiday) => holiday.date.startsWith(`${year}-`))).toBe(true);
      const allDates = dates(calendar);
      expect(allDates).toEqual([...new Set(allDates)].sort());
      expect(calendar.holidays.every((holiday) => holiday.name.length > 0)).toBe(true);
      expect(allDates.every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= '2020-01-01' && date <= '2035-12-31')).toBe(true);
      expect(allDates.every((date) => new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date)).toBe(true);
    }
    expect(selection).toEqual(original);
  });

  it.each(officialSubdivisions)('supports every official $jurisdiction subdivision from the pinned source without a national fallback', ({ jurisdiction, timeZone, codes }) => {
    for (const subdivision of codes) {
      const calendar = known(input({ budget: { jurisdiction, subdivision, timeZone } }));
      expect(calendar).toMatchObject({ jurisdiction, subdivision, timeZone, version: sourceVersion });
      for (let year = 2020; year <= 2035; year += 1) {
        expect(calendar.holidays.some((holiday) => holiday.date.startsWith(`${year}-`))).toBe(true);
      }
    }
  });

  it('includes the US New Year observed date in the preceding year, not only nominal holiday years', () => {
    // v0.105/holidays/countries/united_states.py includes next-year New Year's observation.
    const calendar = known(input({ year: 2021 }));
    expect(calendar.holidays).toContainEqual({ date: '2021-12-31', name: "New Year's Day (observed)" });
    expect(dates(calendar)).toContain('2022-01-01');
    expect(dates(calendar)).not.toContain('2022-01-03');
  });

  it.each(nationalSelections.slice(1))('includes $jurisdiction New Year observed Monday 2022-01-03', (selection) => {
    // v0.105 country CA/GB source: Saturday/Sunday -> next Monday, unlike US preceding Friday.
    const calendar = known(input({ year: 2022, budget: selection }));
    expect(calendar.holidays).toContainEqual({ date: '2022-01-03', name: "New Year's Day (observed)" });
    expect(dates(calendar)).toContain('2022-01-01');
    expect(dates(calendar)).not.toContain('2021-12-31');
  });

  it.each([
    { jurisdiction: 'US', subdivision: 'MA', timeZone: 'America/New_York', localDate: '2024-04-15' },
    { jurisdiction: 'CA', subdivision: 'QC', timeZone: 'America/Toronto', localDate: '2024-06-24' },
    { jurisdiction: 'GB', subdivision: 'SCT', timeZone: 'Europe/London', localDate: '2024-01-02' },
  ])('keeps $subdivision-only holiday $localDate out of the $jurisdiction national calendar', ({ localDate, ...selection }) => {
    const regional = known(input({ budget: selection }));
    const national = known(input({ budget: { ...selection, subdivision: null } }));
    expect(dates(regional)).toContain(localDate);
    expect(dates(national)).not.toContain(localDate);
  });

  it('does not union unrelated subdivisions or optional/government holidays into national public evidence', () => {
    const england = known(input({ budget: { jurisdiction: 'GB', subdivision: 'ENG', timeZone: 'Europe/London' } }));
    const scotland = known(input({ budget: { jurisdiction: 'GB', subdivision: 'SCT', timeZone: 'Europe/London' } }));
    expect(dates(england)).not.toContain('2024-01-02');
    expect(dates(scotland)).toContain('2024-01-02');
    const canada = known(input({ budget: nationalSelections[1]! }));
    // CA PUBLIC national does not pretend federally regulated workplaces' Thanksgiving is national closure.
    expect(dates(canada)).not.toContain('2024-10-14');
  });

  it('uses generated data offline and never invokes Python, subprocesses or calendar network requests', () => {
    for (const selection of nationalSelections) known(input({ budget: selection }));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    for (const call of Object.values(processCalls)) expect(call).not.toHaveBeenCalled();
  });

  it('never invents bank closure evidence or turn ordinary weekends into public holiday facts', () => {
    const calendar = known(input());
    expect(dates(calendar)).not.toContain('2024-02-03'); // ordinary Saturday, not a source public holiday.
    expect(dates(calendar)).not.toContain('2024-02-04');
    for (const holiday of calendar.holidays) expect(Object.keys(holiday).sort()).toEqual(['date', 'name']);
    expect(calendar).not.toHaveProperty('bankClosed');
    expect(calendar).not.toHaveProperty('bankSpecificClosures');
  });
});

describe('dynamic explicit account/budget calendar precedence', () => {
  it('uses the account override and its explicit time zone rather than the budget or browser locale', () => {
    const request = input({ accounts: [{
      accountId: 'account-checking', selection: { jurisdiction: 'CA', subdivision: 'QC', timeZone: 'America/Montreal' },
    }] });
    expect(known(request)).toMatchObject({ accountId: 'account-checking', jurisdiction: 'CA', subdivision: 'QC', timeZone: 'America/Montreal' });
    expect(known({ ...request, accountId: 'account-other' })).toMatchObject({ accountId: null, jurisdiction: 'US', timeZone: 'America/New_York' });
    request.accounts[0]!.selection = { jurisdiction: 'GB', subdivision: 'SCT', timeZone: 'Europe/London' };
    expect(known(request)).toMatchObject({ jurisdiction: 'GB', subdivision: 'SCT', timeZone: 'Europe/London' });
  });

  it('can use an account selection with no budget default and explicit account null disables fallback', () => {
    expect(known(input({ budget: null, accounts: [{ accountId: 'account-checking', selection: nationalSelections[2]! }] })))
      .toMatchObject({ accountId: 'account-checking', jurisdiction: 'GB' });
    expectUnknown(input({ accounts: [{ accountId: 'account-checking', selection: null }] }));
    expectUnknown(input({ budget: null }));
  });

  it('does not silently replace an unsupported account jurisdiction with the known budget calendar', () => {
    expectUnknown(input({ accounts: [{ accountId: 'account-checking', selection: { jurisdiction: 'ZZ', subdivision: null, timeZone: 'UTC' } }] }));
  });

  it.each(['America/New_York', 'America/Los_Angeles', 'Europe/London', 'UTC'])('validates %s without shifting ledger civil dates across DST or UTC', (timeZone) => {
    const baseline = known(input());
    const selected = known(input({ budget: { ...nationalSelections[0]!, timeZone } }));
    expect(selected.timeZone).toBe(timeZone);
    expect(selected.holidays).toEqual(baseline.holidays);
    expect(dates(selected)).toContain('2024-01-01');
  });
});

describe('calendar uncertainty and strict configuration boundary', () => {
  it.each([2019, 2036])('reports calendar_unknown for unsupported year %s, never generated extension or invented closure', (year) => {
    expectUnknown(input({ year }));
  });

  it.each([
    { jurisdiction: 'ZZ', subdivision: null, timeZone: 'UTC' },
    { jurisdiction: 'FR', subdivision: null, timeZone: 'Europe/Paris' },
    { jurisdiction: 'US', subdivision: 'NOT-A-STATE', timeZone: 'America/New_York' },
    { jurisdiction: 'CA', subdivision: 'MA', timeZone: 'America/Toronto' },
    { jurisdiction: 'GB', subdivision: 'QC', timeZone: 'Europe/London' },
  ])('preserves ordinary-cadence uncertainty for unsupported selection %j', (budget) => {
    expectUnknown(input({ budget }));
  });

  it.each(['', 'Mars/Olympus', '+05:30', 'GMT+2', 'America/New_York\u0000'])('rejects invalid explicit time zone %j rather than substituting host zone', (timeZone) => {
    expectInvalid(input({ budget: { ...nationalSelections[0]!, timeZone } }));
    expectInvalid(input({ accounts: [{ accountId: 'account-checking', selection: { ...nationalSelections[1]!, timeZone } }] }));
  });

  it.each([2024.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects malformed year %s instead of coercion to a known year', (year) => {
    expectInvalid(input({ year }));
  });

  it('rejects duplicate account overrides and unrecognized top-level or selection fields', () => {
    expectInvalid(input({ accounts: [
      { accountId: 'account-checking', selection: nationalSelections[0]! },
      { accountId: 'account-checking', selection: nationalSelections[1]! },
    ] }));
    expectInvalid({ ...input(), locale: 'en-US' } as unknown as MerchantCalendarLookupInput);
    expectInvalid(input({ budget: { ...nationalSelections[0]!, bankClosed: true } as unknown as MerchantCalendarSelection }));
    expectInvalid(input({ budget: { ...nationalSelections[0]!, timeZone: null } as unknown as MerchantCalendarSelection }));
  });
});

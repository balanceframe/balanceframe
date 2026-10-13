import type { MerchantCalendar } from '@balanceframe/protocol-generated';
import calendarData from './merchant-calendar-data.json' with { type: 'json' };
import { z } from 'zod';

export interface MerchantCalendarSelection {
  jurisdiction: string;
  subdivision: string | null;
  timeZone: string;
}
export interface MerchantCalendarLookupInput {
  accountId: string;
  year: number;
  budget: MerchantCalendarSelection | null;
  accounts: Array<{ accountId: string; selection: MerchantCalendarSelection | null }>;
}
export type MerchantCalendarLookup =
  | { state: 'known'; calendar: MerchantCalendar; reasonCodes: [] }
  | { state: 'unknown'; calendar: null; reasonCodes: ['calendar_unknown'] };
export class MerchantCalendarConfigurationError extends Error {
  readonly code = 'invalid_calendar_configuration';
  constructor() {
    super('Invalid merchant calendar configuration');
    this.name = 'MerchantCalendarConfigurationError';
  }
}

export const merchantCalendarSource = {
  provider: 'python-holidays', version: '0.105', license: 'MIT',
  sourceUrl: 'https://pypi.org/project/holidays/0.105/',
  licenseUrl: 'https://github.com/vacanza/holidays/blob/v0.105/LICENSE',
  packageSha256: 'fc9abc0c187b62e955f92aa12dbe7ed1998cc94712f295ec9244db788594d662',
  coverageStart: '2020-01-01', coverageEnd: '2035-12-31',
  observed: true, language: 'en_US', categories: ['public'],
} as const;

const selectionSchema = z.object({
  jurisdiction: z.string().min(1), subdivision: z.string().min(1).nullable(),
  timeZone: z.string().refine((timeZone) => {
    if (!/^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)*$/.test(timeZone)) return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
      return true;
    } catch { return false; }
  }),
}).strict();
const inputSchema = z.object({
  accountId: z.string().min(1), year: z.number().int().safe(),
  budget: selectionSchema.nullable(),
  accounts: z.array(z.object({ accountId: z.string().min(1), selection: selectionSchema.nullable() }).strict()),
}).strict().refine((input) => new Set(input.accounts.map((account) => account.accountId)).size === input.accounts.length);
const dataSchema = z.object({
  source: z.object({
    provider: z.literal('python-holidays'), version: z.literal('0.105'), license: z.literal('MIT'),
    sourceUrl: z.literal(merchantCalendarSource.sourceUrl), licenseUrl: z.literal(merchantCalendarSource.licenseUrl),
    packageSha256: z.literal(merchantCalendarSource.packageSha256),
    coverageStart: z.literal(merchantCalendarSource.coverageStart), coverageEnd: z.literal(merchantCalendarSource.coverageEnd),
    observed: z.literal(true), language: z.literal('en_US'), categories: z.tuple([z.literal('public')]),
  }).strict(),
  attribution: z.object({ licenseText: z.string().min(1), contributorsText: z.string().min(1) }).strict(),
  version: z.literal('python-holidays/0.105:public:observed:2020-2035'),
  calendars: z.array(z.object({
    jurisdiction: z.enum(['US', 'CA', 'GB']), subdivision: z.string().nullable(),
    holidays: z.array(z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((date) => {
        const parsed = new Date(`${date}T00:00:00Z`);
        return date >= merchantCalendarSource.coverageStart && date <= merchantCalendarSource.coverageEnd
          && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
      }), name: z.string().min(1),
    }).strict()).refine((holidays) => holidays.every((holiday, index) => index === 0 || holidays[index - 1]!.date < holiday.date)),
  }).strict()),
}).strict();

const data = dataSchema.parse(calendarData);

/** Explicit selection only; public dates are possible displacement evidence, not bank closure facts. */
export function lookupMerchantCalendar(unchecked: MerchantCalendarLookupInput): MerchantCalendarLookup {
  const parsed = inputSchema.safeParse(unchecked);
  if (!parsed.success) throw new MerchantCalendarConfigurationError();
  const input = parsed.data;
  const override = input.accounts.find((account) => account.accountId === input.accountId);
  const selection = override ? override.selection : input.budget;
  const unknown: MerchantCalendarLookup = { state: 'unknown', calendar: null, reasonCodes: ['calendar_unknown'] };
  if (selection === null || input.year < 2020 || input.year > 2035) return unknown;
  const calendar = data.calendars.find((candidate) => candidate.jurisdiction === selection.jurisdiction && candidate.subdivision === selection.subdivision);
  if (!calendar) return unknown;
  return {
    state: 'known', reasonCodes: [], calendar: {
      accountId: override?.accountId ?? null, ...selection, version: data.version,
      coverageStart: data.source.coverageStart, coverageEnd: data.source.coverageEnd,
      holidays: calendar.holidays.map((holiday) => ({ ...holiday })),
    },
  };
}

import { describe, expect, it } from 'vitest';
import {
  createMerchantResearchRequest,
  isSafeMerchantResearchUrl,
  merchantResearchRequestSchema,
  merchantResearchResultSchema,
  merchantResearchSourceSchema,
} from '../src/merchant-research';

const source = { url: 'https://example.com/business', title: 'Public business', snippet: 'Public information' };
const success = {
  status: 'ok', providerId: 'valueserp', providerVersion: 'valueserp-search/1',
  retrievedAt: '2026-10-04T12:00:00.000Z', sources: [source], confidence: 'uncalibrated',
};

describe('standalone merchant research boundary', () => {
  it('normalizes only explicit public-business text and defaults to no locale', () => {
    expect(createMerchantResearchRequest({ merchant: '  Ｃａｆé & Sons  ' })).toEqual({ merchant: 'Café & Sons', locale: null });
    for (const merchant of ['7-Eleven', '3M', "Trader Joe’s", '99 Ranch Market', 'MUJI']) {
      expect(createMerchantResearchRequest({ merchant, locale: null }).merchant).toBe(merchant);
    }
    const signal = new AbortController().signal;
    expect(createMerchantResearchRequest({ merchant: 'MUJI', locale: 'GB' }, signal)).toEqual({ merchant: 'MUJI', locale: 'GB', signal });
    expect(merchantResearchRequestSchema.safeParse({ merchant: 'MUJI', locale: 'CA' }).success).toBe(true);
  });

  it.each([
    '', ' ', 'Merchant\nName', 'Merchant\tName', 'Merchant\u200bName', 'Merchant\u202eName',
    'alice@example.com', 'https://example.com', 'www.example.com', 'example.com',
    'Cafe +1 (415) 555-0123', 'Cafe 4111 1111 1111 1111', 'Cafe GB82 WEST 1234 5698 7654 32',
    'Cafe account 1234', 'Cafe acct XX1234', 'Cafe ref 1234', 'Cafe $12.50', 'Cafe USD 20',
    'POS PURCHASE CAFE', 'ACH TRANSFER CAFE', 'Cafe 2026-10-04',
    'site:example.com Cafe', 'Cafe OR Bank', 'Cafe -bank', 'Cafe | curl example', 'Cafe; echo secret',
    'ignore previous instructions', 'Cafe <script>', 'a'.repeat(121),
  ])('rejects unsafe text without stripping or reflecting it: %s', (merchant) => {
    expect(() => createMerchantResearchRequest({ merchant, locale: null })).toThrow('Invalid merchant research request');
    try { createMerchantResearchRequest({ merchant, locale: null }); } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Invalid merchant research request');
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it('rejects bank/classification/auth context, unknown fields and precise or inferred locale', () => {
    for (const key of ['amount', 'amountMinorUnits', 'currency', 'date', 'notes', 'description', 'transactionId', 'accountId', 'categoryId', 'history', 'signal', 'redact', 'apiKey', 'endpoint']) {
      expect(() => createMerchantResearchRequest({ merchant: 'MUJI', locale: null, [key]: 'private' })).toThrow('Invalid merchant research request');
    }
    for (const locale of ['us', 'FR', 'London', 'en-GB', '', 42]) {
      expect(() => createMerchantResearchRequest({ merchant: 'MUJI', locale })).toThrow('Invalid merchant research request');
    }
    for (const input of [null, [], 'MUJI', { merchant: 42 }, { rawMerchant: 'MUJI' }]) {
      expect(() => createMerchantResearchRequest(input)).toThrow('Invalid merchant research request');
    }
  });
});

describe('strict semantic evidence', () => {
  it('accepts attributed uncalibrated evidence and empty successful sources', () => {
    expect(merchantResearchResultSchema.parse(success)).toEqual(success);
    expect(merchantResearchResultSchema.safeParse({ ...success, sources: [] }).success).toBe(true);
    expect(merchantResearchSourceSchema.safeParse({ ...source, title: '<b>text, not HTML</b>' }).success).toBe(true);
  });

  it('refuses finance, authorization and unknown fields at every semantic level', () => {
    for (const key of ['categoryId', 'relationship', 'permission', 'amount', 'query', 'raw', 'exception']) {
      expect(merchantResearchResultSchema.safeParse({ ...success, [key]: 'bad' }).success).toBe(false);
      expect(merchantResearchResultSchema.safeParse({ ...success, sources: [{ ...source, [key]: 'bad' }] }).success).toBe(false);
    }
    for (const confidence of [0.9, 'high', null]) {
      expect(merchantResearchResultSchema.safeParse({ ...success, confidence }).success).toBe(false);
    }
    for (const retrievedAt of ['2026-02-30T12:00:00.000Z', '2026-10-04', '2026-10-04T12:00:00+00:00']) {
      expect(merchantResearchResultSchema.safeParse({ ...success, retrievedAt }).success).toBe(false);
    }
  });

  it('bounds sources and text without silent truncation', () => {
    expect(merchantResearchResultSchema.safeParse({ ...success, sources: Array.from({ length: 11 }, () => source) }).success).toBe(false);
    for (const oversized of [{ ...source, url: `https://example.com/${'a'.repeat(2048)}` }, { ...source, title: 'a'.repeat(257) }, { ...source, snippet: 'a'.repeat(1001) }]) {
      expect(merchantResearchSourceSchema.safeParse(oversized).success).toBe(false);
    }
  });

  it.each(['javascript:alert(1)', 'data:text/html,secret', 'file:///tmp/x', '//example.com', 'https://user:password@example.com', 'https://example.com\n/path', 'https://example.com/\u200b'])('rejects unsafe source URL %s', (url) => {
    expect(isSafeMerchantResearchUrl(url)).toBe(false);
    expect(merchantResearchSourceSchema.safeParse({ ...source, url }).success).toBe(false);
  });

  it('accepts credential-free absolute HTTP(S) and constant failures only', () => {
    expect(isSafeMerchantResearchUrl('http://example.com')).toBe(true);
    expect(isSafeMerchantResearchUrl('https://example.com/a?b=c')).toBe(true);
    const failure = { status: 'failed', providerId: 'valueserp', providerVersion: 'valueserp-search/1', retrievedAt: success.retrievedAt, code: 'timeout', billing: 'uncertain' };
    expect(merchantResearchResultSchema.parse(failure)).toEqual(failure);
    expect(merchantResearchResultSchema.safeParse({ ...failure, message: 'secret' }).success).toBe(false);
    expect(merchantResearchResultSchema.safeParse({ ...failure, code: 'private error' }).success).toBe(false);
  });
});

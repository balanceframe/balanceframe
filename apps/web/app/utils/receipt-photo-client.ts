import {
  EvidenceObservationSchema,
  ReceiptEvidenceSchema,
} from '@balanceframe/protocol-generated/validators';
import { z } from 'zod';
export const receiptPhotoOcrResultSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('extracted'),
    engine: z.literal('tesseract'),
    engineVersion: z.literal('5.5.3'),
    modelVersion: z.literal('4.1.0'),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    text: z
      .string()
      .min(1)
      .max(1024 * 1024),
  }),
  z.object({
    state: z.literal('unavailable'),
    reason: z.enum(['not_configured', 'invalid_configuration', 'unreachable', 'invalid_result']),
  }),
]);
export interface ReceiptPhotoForm {
  kind: 'purchase' | 'refund';
  date: string;
  total: string;
  currency: string;
  merchant: string;
  fundingInstrumentId: string;
}
/** Convert decimal notation to native minor units by formatting only. */
function receiptMoney(value: string, currencyInput: string) {
  const currency = currencyInput.trim().toUpperCase();
  const text = value.trim();
  if (!Intl.supportedValuesOf('currency').includes(currency) || text.length > 64) return null;
  const exponent = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (exponent === undefined || !match || (match[2]?.length ?? 0) > exponent) return null;
  const minorUnits = (match[1]! + (match[2] ?? '').padEnd(exponent, '0')).replace(/^0+(?=\d)/, '');
  const amount = EvidenceObservationSchema.shape.amount.safeParse({ minorUnits, currency });
  return amount.success ? amount.data : null;
}
/** Format explicit decimal input as exact native money; no monetary sums or floating point. */
export function receiptPhotoSummary(input: ReceiptPhotoForm) {
  const amount = receiptMoney(input.total, input.currency);
  const date = EvidenceObservationSchema.shape.date.safeParse(input.date);
  const merchant = input.merchant.trim() || null;
  const fundingInstrumentId = input.fundingInstrumentId.trim() || null;
  if (
    !amount ||
    amount.minorUnits === '0' ||
    !date.success ||
    !EvidenceObservationSchema.shape.counterparty.safeParse(merchant).success ||
    !EvidenceObservationSchema.shape.fundingInstrumentId.safeParse(fundingInstrumentId).success
  )
    return null;
  return { kind: input.kind, date: date.data, total: amount, merchant, fundingInstrumentId };
}

export interface ReceiptPhotoItemsForm {
  discount: string;
  tax: string;
  lines: Array<{
    description: string;
    sku: string;
    quantity: string;
    unitGross: string;
    gross: string;
    discount: string;
    tax: string;
    net: string;
  }>;
  tenders: Array<{
    kind: 'card' | 'bank' | 'gift_card' | 'reward' | 'wallet' | 'cash' | '';
    amount: string;
  }>;
}
/** Start optional item entry with unknown fields instead of invented receipt facts. */
export function emptyReceiptPhotoItems(): ReceiptPhotoItemsForm {
  return { discount: '', tax: '', lines: [], tenders: [] };
}
const photoFactsSchema = ReceiptEvidenceSchema.omit({
  id: true,
  observationId: true,
  version: true,
  supersedesId: true,
  fulfillmentGroupId: true,
});
type PhotoExtraction = NonNullable<ReturnType<typeof receiptPhotoSummary>> & {
  receipt?: ReturnType<typeof photoFactsSchema.parse>;
};

/** Copy explicit item/tender claims; Rust alone checks arithmetic and conservation. */
export function receiptPhotoExtraction(
  input: ReceiptPhotoForm,
  items?: ReceiptPhotoItemsForm,
): PhotoExtraction | null {
  const summary = receiptPhotoSummary(input);
  if (!summary) return null;
  if (!items) return summary;
  if (!items.lines.length || !items.tenders.length) return null;
  const money = (value: string) => receiptMoney(value, summary.total.currency);
  const receipt = photoFactsSchema.safeParse({
    total: summary.total,
    discount: money(items.discount),
    tax: money(items.tax),
    lines: items.lines.map((line, index) => {
      const quantity = /^(\d+)(?:\.(\d{1,6}))?$/.exec(line.quantity.trim());
      return {
        id: `entered-line-${index + 1}`,
        rawDescription: line.description,
        normalizedDescription: line.description,
        sku: line.sku.trim() || null,
        quantityMicros: quantity ? Number(quantity[1]! + (quantity[2] ?? '').padEnd(6, '0')) : 0,
        unitGross: money(line.unitGross),
        gross: money(line.gross),
        discount: money(line.discount),
        tax: money(line.tax),
        net: money(line.net),
        department: null,
        productFamily: null,
        categoryId: null,
        memberId: null,
        returnOfLineId: null,
        evidenceStrength: 0,
        reasonCodes: [],
      };
    }),
    tenders: items.tenders.map((tender, index) => ({
      id: `entered-tender-${index + 1}`,
      kind: tender.kind,
      amount: money(tender.amount),
      observationId: null,
    })),
  });
  if (!receipt.success || items.lines.some((line) => !line.description.trim())) return null;
  return { ...summary, receipt: receipt.data };
}

import { evidenceRoute } from '../../utils/transaction-evidence';
import { extractReceiptPhoto, readReceiptPhotoBody } from '../../utils/receipt-ocr';
/** Extract only the supplied camera image on explicit request; manual review remains independent. */
export default evidenceRoute(
  async (event) =>
    extractReceiptPhoto(await readReceiptPhotoBody(event), {
      endpoint: process.env.BALANCEFRAME_RECEIPT_OCR_URL,
    }),
  { write: true, capability: 'ingest' },
);

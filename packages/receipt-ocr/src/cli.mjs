import { createExtractor, verifyRuntime } from './extract.mjs';
import { createReceiptOcrServer } from './server.mjs';

try {
  await verifyRuntime();
  const server = createReceiptOcrServer({ extract: createExtractor() });
  server.listen(8088, '0.0.0.0');
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} catch {
  console.error('Receipt OCR unavailable: pinned engine/library/model verification failed');
  process.exitCode = 1;
}

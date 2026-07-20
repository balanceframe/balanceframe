/**
 * Health check endpoint.
 * Returns server status, version, and operating mode.
 */
export default defineEventHandler(async () => {
  return {
    status: 'ok',
    version: '0.1.0',
    mode: 'observe',
  };
});

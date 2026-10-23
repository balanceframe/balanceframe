import { describe, expect, it } from 'vitest';
import { analysisError } from '../../app/utils/analysis-error';

describe('analysisError', () => {
  it.each([true, false, undefined])(
    'preserves validated server error metadata (%s)',
    (retryable) => {
      expect(
        analysisError({
          data: {
            status: 'error',
            error: { code: 'FORBIDDEN', message: 'Request denied.', retryable },
          },
        }),
      ).toEqual({ code: 'FORBIDDEN', message: 'Request denied.', retryable: retryable ?? false });
    },
  );

  it.each([
    new Error('private details'),
    null,
    undefined,
    'private details',
    { data: null },
    { data: { status: 'error', error: null } },
    {
      data: {
        status: 'ok',
        error: { code: 'PRIVATE', message: 'private details', retryable: true },
      },
    },
    { data: { status: 'error', error: { code: 42, message: 'private details', retryable: true } } },
    { data: { status: 'error', error: { code: 'PRIVATE', message: null, retryable: true } } },
    {
      data: {
        status: 'error',
        error: { code: 'PRIVATE', message: 'private details', retryable: 'yes' },
      },
    },
  ])('returns a generic recoverable failure for unknown or malformed errors', (cause) => {
    expect(analysisError(cause)).toEqual({
      code: 'FETCH_ERROR',
      message: 'Unable to load analysis. Please try again.',
      retryable: true,
    });
  });
});

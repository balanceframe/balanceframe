import { z } from 'zod';

const errorResponse = z.object({
  data: z.object({
    status: z.literal('error'),
    error: z.object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean().optional().default(false),
    }),
  }),
});

/** Preserve API recovery metadata while keeping unknown failures private. */
export function analysisError(cause: unknown) {
  const response = errorResponse.safeParse(cause);
  if (response.success) return response.data.data.error;
  return {
    code: 'FETCH_ERROR',
    message: 'Unable to load analysis. Please try again.',
    retryable: true,
  };
}

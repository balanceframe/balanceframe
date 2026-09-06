export async function liquidityRequest<T>(
  url: string,
  method: 'GET' | 'POST' | 'PUT' = 'GET',
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await $fetch<{
    status: string;
    result: T | null;
    error?: { message: string } | null;
  }>(url, { method, ...(body ? { body } : {}) });
  if (response.status !== 'ok' || response.result === null)
    throw new Error(response.error?.message ?? 'The request could not be completed.');
  return response.result;
}
export function liquidityError(error: unknown): string {
  const failure = error as {
    status?: number;
    statusCode?: number;
    data?: { error?: { message?: string } };
    message?: string;
  };
  if (failure.status === 409 || failure.statusCode === 409)
    return 'This plan or version changed. Refresh, review the current result, and try again.';
  if (failure.status === 403 || failure.statusCode === 403)
    return 'Your current permissions do not allow this operation. Ask an authorized holder.';
  return (
    failure.data?.error?.message ?? failure.message ?? 'Unable to load current data. Try again.'
  );
}

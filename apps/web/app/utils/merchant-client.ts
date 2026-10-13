import type { Envelope } from '../components/types';

/** Same-origin merchant API client; actor and source authority are always server-selected. */
export async function merchantRequest<T>(url: string, method: 'GET' | 'POST' | 'PUT' = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method, credentials: 'same-origin',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error('Connection unavailable. Check the connection and retry loading current evidence.');
  }
  const value: unknown = await response.json().catch(() => null);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid server response. Refresh current evidence before trying again.');
  const envelope = value as Envelope<T>;
  if (!response.ok || envelope.status !== 'ok' || envelope.result == null) {
    if (response.status === 409 || /conflict|stale|expired/i.test(envelope.error?.code ?? ''))
      throw new Error('Evidence or policy changed. Refresh and review the current result before trying again.');
    throw new Error(envelope.error?.message ?? 'Current permissions do not allow this operation. Ask an authorized holder, then refresh.');
  }
  return envelope.result;
}

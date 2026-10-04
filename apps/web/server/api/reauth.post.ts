import { defineEventHandler, readBody, setResponseStatus } from 'h3';
import { z } from 'zod';
import { issueReauthentication, type ReauthenticationEvent } from '../utils/reauthentication';

const PasswordBody = z.object({ password: z.string().min(1).max(128) });

export default defineEventHandler(async (event) => {
  const body = PasswordBody.safeParse(await readBody<unknown>(event));
  const verified =
    body.success &&
    (await issueReauthentication(event as unknown as ReauthenticationEvent, body.data.password));
  if (!verified) {
    setResponseStatus(event, 401);
    return { status: 'error', error: { code: 'REAUTHENTICATION_FAILED' } };
  }
  return { status: 'success' };
});

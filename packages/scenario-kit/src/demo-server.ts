import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, openSync, closeSync, renameSync, writeFileSync } from 'node:fs';
import {
  request as httpRequest,
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { applyScenarioEvent } from './events.js';
import { listScenarios, materializeScenario, type MaterializedScenario } from './catalog.js';
import { builtWebEntry, initializeScenarioShell, type LoadedScenario } from './loader.js';
import {
  createOwnedScenarioRoot,
  discardOwnedScenarioRoot,
  startScenarioShell,
  stopScenarioProcesses,
  type ScenarioProcesses,
} from './process-runtime.js';
import type { ScenarioPersonaCredentials } from './workflow-setup.js';

const MAX_CONTROL_BYTES = 4 * 1024;
const MAX_PROXY_BYTES = 1024 * 1024;
const CONTROL_DURATION_MS = 60 * 60 * 1000;
const LOAD_INTERVAL_MS = 10_000;
const CONTROL_COOKIE = 'bf_demo';
const INTERNAL_HEADER = 'x-balanceframe-demo-internal';
const CSRF_HEADER = 'x-balanceframe-demo-csrf';
const LOOPBACK = '127.0.0.1';

interface Workspace {
  readonly processes: ScenarioProcesses;
  readonly scenario: MaterializedScenario;
  loaded: LoadedScenario | null;
}

type DemoStatus = 'loading' | 'ready' | 'failed';

interface ControlSession {
  readonly generation: number;
  readonly personaId: string;
  readonly expiresAt: number;
  readonly nonce: string;
}

interface Supervisor {
  readonly listener: Server;
  readonly secret: Buffer;
  readonly origin: URL;
  readonly host: string;
  readonly webEntry: string;
  current: Workspace | null;
  generation: number;
  scenarioId: string;
  anchor: string | null;
  status: DemoStatus;
  failureCode: string | null;
  busy: boolean;
  activeFinancial: number;
  drainFinancial: (() => void) | null;
  lastLoadAt: number;
  stopping: boolean;
}

/** Public, non-authorizing handle for one owned demo listener. */
export interface DemoServer {
  readonly url: string;
}

export interface StartDemoServerOptions {
  readonly scenarioId?: string;
  readonly host?: string;
  readonly port?: number;
  readonly origin?: string;
}

const supervisors = new WeakMap<DemoServer, Supervisor>();

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function error(
  response: ServerResponse,
  status: number,
  code: string,
  headers: Record<string, string> = {},
): void {
  json(response, status, { error: { code } }, headers);
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' ? value : null;
}

function requestPath(request: IncomingMessage): { path: string; search: URLSearchParams } | null {
  const target = request.url;
  if (
    !target ||
    !target.startsWith('/') ||
    target.startsWith('//') ||
    target.includes('\\') ||
    target.includes('#')
  )
    return null;
  try {
    const url = new URL(target, 'http://127.0.0.1');
    if (url.pathname.split('/').some((segment) => segment === '.' || segment === '..')) return null;
    if (/%2f|%5c|%2e/i.test(target.split('?')[0]!)) return null;
    return { path: url.pathname, search: url.searchParams };
  } catch {
    return null;
  }
}

function unsafeMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

function validHost(request: IncomingMessage, origin: URL): boolean {
  return header(request, 'host') === origin.host;
}

function validUnsafeOrigin(request: IncomingMessage, origin: URL): boolean {
  return header(request, 'origin') === origin.origin;
}

function validatePublicOrigin(origin: string, host: string): URL {
  const parsed = new URL(origin);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  )
    throw new Error('Demo origin must be an exact HTTP(S) origin');
  if (host !== LOOPBACK && host !== 'localhost' && host !== '::1' && parsed.protocol !== 'https:') {
    throw new Error('A non-loopback demo listener requires a configured HTTPS origin');
  }
  return parsed;
}

function signing(secret: Buffer, input: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

function equal(a: string, b: string): boolean {
  const provided = Buffer.from(a);
  const expected = Buffer.from(b);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function cookieValue(request: IncomingMessage, name: string): string | null {
  const cookie = header(request, 'cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function signControl(supervisor: Supervisor, personaId: string): string {
  const session: ControlSession = {
    generation: supervisor.generation,
    personaId,
    expiresAt: Date.now() + CONTROL_DURATION_MS,
    nonce: randomBytes(16).toString('base64url'),
  };
  const encoded = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `${encoded}.${signing(supervisor.secret, encoded)}`;
}

function readControl(
  supervisor: Supervisor,
  request: IncomingMessage,
): { token: string; session: ControlSession } | null {
  const token = cookieValue(request, CONTROL_COOKIE);
  if (!token) return null;
  const [encoded, signature, extra] = token.split('.');
  if (
    !encoded ||
    !signature ||
    extra !== undefined ||
    !equal(signature, signing(supervisor.secret, encoded))
  )
    return null;
  try {
    const session = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as ControlSession;
    if (
      !Number.isSafeInteger(session.generation) ||
      !Number.isSafeInteger(session.expiresAt) ||
      session.expiresAt <= Date.now() ||
      typeof session.personaId !== 'string' ||
      typeof session.nonce !== 'string' ||
      session.nonce.length < 12
    )
      return null;
    return { token, session };
  } catch {
    return null;
  }
}

function csrf(supervisor: Supervisor, token: string): string {
  return signing(supervisor.secret, `csrf:${token}`);
}

function issueControl(supervisor: Supervisor, response: ServerResponse, personaId: string): string {
  const token = signControl(supervisor, personaId);
  response.setHeader('set-cookie', [
    `${CONTROL_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600${supervisor.origin.protocol === 'https:' ? '; Secure' : ''}`,
  ]);
  return token;
}

function appendCookies(response: ServerResponse, values: readonly string[]): void {
  const previous = response.getHeader('set-cookie');
  const cookies = Array.isArray(previous)
    ? previous.map(String)
    : previous
      ? [String(previous)]
      : [];
  response.setHeader('set-cookie', [...cookies, ...values]);
}

function writeManifest(
  processes: ScenarioProcesses,
  generation: number,
  phase: 'setup' | 'ready',
  budgetId: string | null,
  actorIds: readonly string[],
): void {
  const manifest = {
    version: 1,
    phase,
    generation,
    origin: processes.publicOrigin,
    actualUrl: processes.actualUrl,
    root: processes.root,
    authDbPath: processes.authDbPath,
    workflowDbPath: processes.workflowDbPath,
    connectionPath: processes.connectionPath,
    internalSecret: processes.internalSecret,
    budgetId,
    actorIds,
  };
  const temporary = join(processes.root, `.manifest-${randomBytes(12).toString('hex')}`);
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(descriptor, JSON.stringify(manifest));
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, processes.manifestPath);
}

async function startWorkspace(
  supervisor: Supervisor,
  scenarioId: string,
  generation: number,
): Promise<Workspace> {
  const scenario = materializeScenario(scenarioId, new Date());
  const root = createOwnedScenarioRoot();
  let processes: ScenarioProcesses;
  try {
    processes = await startScenarioShell({
      root,
      publicOrigin: supervisor.origin.origin,
      webEntry: supervisor.webEntry,
      demoMode: true,
    });
  } catch (failure) {
    discardOwnedScenarioRoot(root);
    throw failure;
  }
  try {
    writeManifest(processes, generation, 'setup', null, []);
  } catch (failure) {
    await stopScenarioProcesses(processes);
    throw failure;
  }
  return { scenario, processes, loaded: null };
}

async function populateWorkspace(workspace: Workspace, generation: number): Promise<void> {
  const loaded = await initializeScenarioShell(
    workspace.processes,
    workspace.scenario,
    workspace.processes.internalSecret,
  );
  writeManifest(
    workspace.processes,
    generation,
    'ready',
    loaded.seeded.budgetId,
    Object.values(loaded.initialized.personas).map((persona) => persona.actorId),
  );
  workspace.loaded = loaded;
}

function personaCredentials(
  workspace: Workspace,
  personaId: string,
): ScenarioPersonaCredentials | null {
  return workspace.loaded?.initialized.personas[personaId] ?? null;
}

function internalHeaders(supervisor: Supervisor, workspace: Workspace): Record<string, string> {
  return {
    host: supervisor.origin.host,
    origin: supervisor.origin.origin,
    'x-forwarded-host': supervisor.origin.host,
    'x-forwarded-proto': supervisor.origin.protocol.slice(0, -1),
    [INTERNAL_HEADER]: workspace.processes.internalSecret,
  };
}

async function signInPersona(
  supervisor: Supervisor,
  workspace: Workspace,
  personaId: string,
): Promise<string[]> {
  const credentials = personaCredentials(workspace, personaId);
  if (!credentials) throw new Error('Scenario persona is unavailable');
  const response = await fetch(`${workspace.processes.webUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { ...internalHeaders(supervisor, workspace), 'content-type': 'application/json' },
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
  });
  if (!response.ok) throw new Error('Scenario persona sign-in failed');
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length === 0) throw new Error('Scenario persona sign-in omitted session cookies');
  const pairs = setCookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
  const session = await fetch(`${workspace.processes.webUrl}/api/auth/get-session`, {
    headers: { ...internalHeaders(supervisor, workspace), cookie: pairs },
  });
  const body = (await session.json()) as { user?: { id?: string } };
  if (!session.ok || body.user?.id !== credentials.actorId)
    throw new Error('Scenario persona identity mismatch');
  const selected = await fetch(`${workspace.processes.webUrl}/api/spaces/${credentials.spaceId}/select`, {
    method: 'POST',
    headers: {
      ...internalHeaders(supervisor, workspace),
      cookie: pairs,
      'x-balanceframe-space': credentials.spaceId,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  if (!selected.ok) throw new Error('Scenario persona space selection failed');
  return [...setCookies, ...selected.headers.getSetCookie()];
}

async function verifyNativeReadiness(supervisor: Supervisor, workspace: Workspace): Promise<void> {
  const owner = personaCredentials(workspace, 'owner');
  if (!owner) throw new Error('Scenario owner is unavailable');
  const response = await fetch(`${workspace.processes.webUrl}/api/liquidity/spendability`, {
    headers: {
      ...internalHeaders(supervisor, workspace),
      cookie: owner.cookieHeader,
      'x-balanceframe-space': owner.spaceId,
    },
  });
  const body: unknown = await response.json().catch(() => null);
  if (
    !response.ok ||
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    (body as { status?: unknown }).status !== 'ok'
  ) {
    throw new Error('Native scenario financial readiness failed');
  }
}

function publicState(
  supervisor: Supervisor,
  control: { token: string; session: ControlSession } | null,
): Record<string, unknown> {
  const active = control?.session.generation === supervisor.generation ? control : null;
  return {
    status: supervisor.status,
    scenarioId: supervisor.scenarioId,
    generation: supervisor.generation,
    anchor: supervisor.anchor,
    shared: true,
    personaIds: supervisor.current?.scenario.personas.map(({ id }) => id) ?? [],
    personaId: active?.session.personaId ?? null,
    csrfToken: active ? csrf(supervisor, active.token) : null,
    ...(supervisor.failureCode ? { failureCode: supervisor.failureCode } : {}),
  };
}

function trackFinancial(supervisor: Supervisor): () => void {
  supervisor.activeFinancial += 1;
  return () => {
    supervisor.activeFinancial -= 1;
    if (supervisor.activeFinancial === 0) {
      supervisor.drainFinancial?.();
      supervisor.drainFinancial = null;
    }
  };
}

async function waitForFinancialDrain(supervisor: Supervisor): Promise<void> {
  if (supervisor.activeFinancial === 0) return;
  await new Promise<void>((resolve) => {
    supervisor.drainFinancial = resolve;
  });
}

async function readBody(
  request: IncomingMessage,
  limit: number,
): Promise<Record<string, unknown> | null> {
  if (header(request, 'content-type')?.split(';', 1)[0]?.trim() !== 'application/json') return null;
  const length = header(request, 'content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) return null;
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) return null;
    size += chunk.length;
    if (size > limit) return null;
    parts.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function canWriteFinancial(method: string, path: string): boolean {
  if (
    method === 'POST' &&
    (path === '/api/spend-sessions' ||
      path === '/api/liquidity/claims' ||
      path === '/api/liquidity/reallocation-preview' ||
      path === '/api/transfer/preview' ||
      path === '/api/transfer/propose' ||
      /^\/api\/liquidity\/claims\/[^/]+\/release$/.test(path) ||
      /^\/api\/transfer\/[^/]+\/(?:approve|cancel|instructions|report-initiated|reconcile)$/.test(
        path,
      ) ||
      /^\/api\/spend-sessions\/[^/]+\/completions(?:\/[^/]+\/(?:approve|execute|reconcile))?$/.test(
        path,
      ))
  )
    return true;
  if (
    method === 'PUT' &&
    (/^\/api\/spend-sessions\/[^/]+$/.test(path) ||
      /^\/api\/liquidity\/(?:policy|observations|grants|preferences)$/.test(path))
  )
    return true;
  return method === 'DELETE' && /^\/api\/spend-sessions\/[^/]+$/.test(path);
}

function forbiddenProxyPath(method: string, path: string): boolean {
  if (!path.startsWith('/api/')) return false;
  if (method === 'POST' && path === '/api/auth/sign-out') return false;
  if (!unsafeMethod(method)) return false;
  return !canWriteFinancial(method, path);
}

function safeProxyHeaders(
  supervisor: Supervisor,
  request: IncomingMessage,
): Record<string, string | string[]> {
  const removed = new Set([
    'host',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'forwarded',
    'x-real-ip',
    INTERNAL_HEADER,
  ]);
  for (const field of (header(request, 'connection') ?? '').split(','))
    removed.add(field.trim().toLowerCase());
  const clean: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || removed.has(name) || name.startsWith('x-forwarded-')) continue;
    clean[name] = value;
  }
  clean.host = supervisor.origin.host;
  clean['x-forwarded-host'] = supervisor.origin.host;
  clean['x-forwarded-proto'] = supervisor.origin.protocol.slice(0, -1);
  return clean;
}

async function proxy(
  supervisor: Supervisor,
  request: IncomingMessage,
  response: ServerResponse,
  workspace: Workspace,
): Promise<void> {
  const target = new URL(workspace.processes.webUrl);
  const method = request.method ?? '';
  const contentLength = header(request, 'content-length');
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_PROXY_BYTES)) {
    error(response, 413, 'DEMO_BODY_TOO_LARGE');
    return;
  }
  await new Promise<void>((resolve) => {
    const upstream = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method,
        path: request.url,
        headers: safeProxyHeaders(supervisor, request),
      },
      (incoming) => {
        const responseHeaders = { ...incoming.headers };
        delete responseHeaders.connection;
        delete responseHeaders['transfer-encoding'];
        responseHeaders['cache-control'] = 'no-store';
        const existingCookies = response.getHeader('set-cookie');
        if (existingCookies) {
          const own = Array.isArray(existingCookies)
            ? existingCookies.map(String)
            : [String(existingCookies)];
          const child = responseHeaders['set-cookie'];
          responseHeaders['set-cookie'] = [
            ...own,
            ...(Array.isArray(child) ? child : child ? [child] : []),
          ];
        }
        response.writeHead(incoming.statusCode ?? 502, responseHeaders);
        incoming.pipe(response);
        incoming.once('end', resolve);
        incoming.once('error', () => {
          response.destroy();
          resolve();
        });
      },
    );
    upstream.once('error', () => {
      error(response, 502, 'DEMO_UPSTREAM_UNAVAILABLE');
      resolve();
    });
    let count = 0;
    request.on('data', (chunk: Buffer) => {
      count += chunk.length;
      if (count > MAX_PROXY_BYTES) {
        request.unpipe(upstream);
        upstream.destroy();
        error(response, 413, 'DEMO_BODY_TOO_LARGE');
        resolve();
      }
    });
    request.pipe(upstream);
  });
}

async function authorizedActor(
  supervisor: Supervisor,
  workspace: Workspace,
  request: IncomingMessage,
): Promise<string | null> {
  const cookie = header(request, 'cookie');
  if (!cookie) return null;
  const result = await fetch(`${workspace.processes.webUrl}/api/auth/get-session`, {
    headers: { ...internalHeaders(supervisor, workspace), cookie },
  });
  if (!result.ok) return null;
  const body: unknown = await result.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const user = (body as { user?: unknown }).user;
  if (!user || typeof user !== 'object' || Array.isArray(user)) return null;
  const actorId = (user as { id?: unknown }).id;
  return typeof actorId === 'string' ? actorId : null;
}

async function allowedEntry(
  supervisor: Supervisor,
  workspace: Workspace,
  personaId: string,
  request: IncomingMessage,
): Promise<{ path: string; input?: unknown }> {
  const mapped = workspace.loaded?.initialized.entry;
  if (!mapped) return { path: '/liquidity' };
  const cookie = header(request, 'cookie') ?? '';
  const headers = { ...internalHeaders(supervisor, workspace), cookie };
  let path: string;
  if (mapped.kind === 'purchase') path = '/api/liquidity/spendability';
  else if (mapped.kind === 'session') path = `/api/spend-sessions/${mapped.sessionId}`;
  else path = `/api/spend-sessions/${mapped.sessionId}/completions/${mapped.completionId}`;
  const response = await fetch(`${workspace.processes.webUrl}${path}`, { headers });
  if (!response.ok) return { path: '/liquidity' };
  if (mapped.kind === 'session') return { path: `/spend-sessions/${mapped.sessionId}` };
  if (mapped.kind === 'completion')
    return { path: `/spend-sessions/${mapped.sessionId}/completions/${mapped.completionId}` };
  const envelope = (await response.json()) as {
    result?: { accounts?: { id: string }[]; categories?: { id: string }[] };
  };
  const input = mapped.input;
  if (
    !envelope.result?.categories?.some(({ id }) => id === input.categoryId) ||
    (input.accountId && !envelope.result.accounts?.some(({ id }) => id === input.accountId)) ||
    !personaCredentials(workspace, personaId)
  )
    return { path: '/liquidity' };
  return { path: '/purchase-check', input };
}

async function handleControl(
  supervisor: Supervisor,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): Promise<void> {
  const method = request.method ?? '';
  if (path === '/__demo/catalog' && method === 'GET') {
    json(response, 200, { scenarios: listScenarios() });
    return;
  }
  if (path === '/__demo/state' && method === 'GET') {
    json(response, 200, publicState(supervisor, readControl(supervisor, request)));
    return;
  }
  if (path === '/__demo/entry' && method === 'GET') {
    const expected = requestPath(request)?.search.get('generation');
    if (!expected || !/^\d+$/.test(expected) || Number(expected) !== supervisor.generation) {
      error(response, 409, 'DEMO_STALE_GENERATION');
      return;
    }
    const workspace = supervisor.current;
    if (supervisor.busy || supervisor.status !== 'ready' || !workspace?.loaded) {
      error(response, 503, 'DEMO_NOT_READY');
      return;
    }
    const control = readControl(supervisor, request);
    if (!control || control.session.generation !== supervisor.generation) {
      error(response, 401, 'DEMO_AUTH_REQUIRED');
      return;
    }
    const done = trackFinancial(supervisor);
    try {
      const credentials = personaCredentials(workspace, control.session.personaId);
      const actorId = await authorizedActor(supervisor, workspace, request);
      if (!credentials || actorId !== credentials.actorId) {
        error(response, 401, 'DEMO_AUTH_REQUIRED');
        return;
      }
      json(response, 200, {
        generation: supervisor.generation,
        ...(await allowedEntry(supervisor, workspace, control.session.personaId, request)),
      });
    } finally {
      done();
    }
    return;
  }
  if (
    !['/__demo/load', '/__demo/reset', '/__demo/persona', '/__demo/reauth', '/__demo/event'].includes(path) ||
    method !== 'POST'
  ) {
    error(response, 404, 'DEMO_CONTROL_UNAVAILABLE');
    return;
  }
  if (!validUnsafeOrigin(request, supervisor.origin)) {
    error(response, 403, 'DEMO_ORIGIN_DENIED');
    return;
  }
  const payload = await readBody(request, MAX_CONTROL_BYTES);
  if (!payload || !Number.isSafeInteger(payload.expectedGeneration)) {
    error(response, 400, 'DEMO_INVALID_CONTROL');
    return;
  }
  if (payload.expectedGeneration !== supervisor.generation) {
    error(response, 409, 'DEMO_STALE_GENERATION');
    return;
  }
  const control = readControl(supervisor, request);
  if (
    !control ||
    control.session.generation !== supervisor.generation ||
    !equal(header(request, CSRF_HEADER) ?? '', csrf(supervisor, control.token))
  ) {
    error(response, 403, 'DEMO_CONTROL_DENIED');
    return;
  }
  if (supervisor.busy) {
    error(response, 409, 'DEMO_BUSY');
    return;
  }
  const current = supervisor.current;
  if (path === '/__demo/persona') {
    if (
      supervisor.status !== 'ready' ||
      typeof payload.personaId !== 'string' ||
      !current?.loaded ||
      !personaCredentials(current, payload.personaId)
    ) {
      error(response, 400, 'DEMO_UNKNOWN_PERSONA');
      return;
    }
    const done = trackFinancial(supervisor);
    try {
      const cookies = await signInPersona(supervisor, current, payload.personaId);
      if (
        supervisor.busy ||
        supervisor.current !== current ||
        supervisor.generation !== control.session.generation
      ) {
        error(response, 409, 'DEMO_STALE_GENERATION');
        return;
      }
      issueControl(supervisor, response, payload.personaId);
      appendCookies(response, cookies);
      json(response, 200, { generation: supervisor.generation, path: '/demo' });
    } finally {
      done();
    }
    return;
  }
  if (path === '/__demo/reauth') {
    if (supervisor.status !== 'ready' || !current?.loaded) {
      error(response, 503, 'DEMO_NOT_READY');
      return;
    }
    const done = trackFinancial(supervisor);
    try {
      const credentials = personaCredentials(current, control.session.personaId);
      const cookie = header(request, 'cookie');
      if (!cookie || !credentials ||
        await authorizedActor(supervisor, current, request) !== credentials.actorId) {
        error(response, 401, 'DEMO_AUTH_REQUIRED');
        return;
      }
      // Let Source verify the browser's existing selection and current membership;
      // do not silently select a space on the browser's behalf.
      const selected = await fetch(`${current.processes.webUrl}/api/spaces/${credentials.spaceId}`, {
        headers: { ...internalHeaders(supervisor, current), cookie },
      });
      const selectedBody = await selected.json().catch(() => null) as {
        result?: { space?: { id?: string; membership?: { id?: string; actorId?: string } } };
      } | null;
      const space = selectedBody?.result?.space;
      if (!selected.ok || space?.id !== credentials.spaceId ||
        space.membership?.id !== credentials.membershipId ||
        space.membership.actorId !== credentials.actorId) {
        error(response, 403, 'DEMO_SPACE_REQUIRED');
        return;
      }
      const renewed = await fetch(`${current.processes.webUrl}/api/reauth`, {
        method: 'POST',
        headers: {
          ...internalHeaders(supervisor, current), cookie,
          'x-balanceframe-space': credentials.spaceId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ password: credentials.password }),
      });
      const stillCurrent = readControl(supervisor, request);
      if (supervisor.busy || supervisor.current !== current ||
        supervisor.generation !== control.session.generation ||
        stillCurrent?.token !== control.token ||
        stillCurrent.session.personaId !== control.session.personaId) {
        error(response, 409, 'DEMO_STALE_GENERATION');
        return;
      }
      const proofCookies = renewed.headers.getSetCookie()
        .filter((value) => /^balanceframe_reauth=[^;]+;/.test(value));
      if (!renewed.ok || proofCookies.length !== 1) {
        error(response, 401, 'DEMO_REAUTHENTICATION_FAILED');
        return;
      }
      appendCookies(response, proofCookies);
      json(response, 200, { generation: supervisor.generation, reauthenticated: true });
    } catch {
      error(response, 503, 'DEMO_REAUTHENTICATION_UNAVAILABLE');
    } finally {
      done();
    }
    return;
  }
  if (path === '/__demo/event') {
    if (supervisor.status !== 'ready' || !current?.loaded) {
      error(response, 503, 'DEMO_NOT_READY');
      return;
    }
    const eventId = payload.eventId;
    if (
      (eventId !== 'categorize-uncategorized' &&
        eventId !== 'import-match' &&
        eventId !== 'import-ambiguous') ||
      !Object.hasOwn(current.scenario.events, eventId)
    ) {
      error(response, 400, 'DEMO_UNKNOWN_EVENT');
      return;
    }
    supervisor.busy = true;
    await waitForFinancialDrain(supervisor);
    try {
      const applied = await applyScenarioEvent({
        scenario: current.scenario,
        seeded: current.loaded.seeded,
        root: current.processes.root,
        actualServerUrl: current.processes.actualUrl,
        actualSecretKey: current.processes.actualSecretKey,
        eventId,
      });
      json(response, 200, { generation: supervisor.generation, eventId: applied.eventId });
    } catch {
      error(response, 503, 'DEMO_EVENT_FAILED');
    } finally {
      supervisor.busy = false;
    }
    return;
  }
  const nextId = path === '/__demo/reset' ? supervisor.scenarioId : payload.scenarioId;
  if (typeof nextId !== 'string' || !listScenarios().some(({ id }) => id === nextId)) {
    error(response, 400, 'DEMO_UNKNOWN_SCENARIO');
    return;
  }
  const now = Date.now();
  if (now - supervisor.lastLoadAt < LOAD_INTERVAL_MS) {
    error(response, 429, 'DEMO_LOAD_RATE_LIMIT', {
      'retry-after': String(Math.ceil((LOAD_INTERVAL_MS - (now - supervisor.lastLoadAt)) / 1000)),
    });
    return;
  }
  supervisor.lastLoadAt = now;
  supervisor.busy = true;
  supervisor.status = 'loading';
  await waitForFinancialDrain(supervisor);
  const generation = supervisor.generation + 1;
  let candidate: Workspace | null = null;
  try {
    candidate = await startWorkspace(supervisor, nextId, generation);
    await populateWorkspace(candidate, generation);
    await verifyNativeReadiness(supervisor, candidate);
    const cookies = await signInPersona(supervisor, candidate, 'owner');
    const previous = supervisor.current;
    supervisor.current = candidate;
    supervisor.generation = generation;
    supervisor.scenarioId = nextId;
    supervisor.anchor = candidate.scenario.anchor;
    supervisor.failureCode = null;
    if (previous) await stopScenarioProcesses(previous.processes);
    supervisor.status = 'ready';
    issueControl(supervisor, response, 'owner');
    appendCookies(response, cookies);
    json(response, 200, {
      status: 'ready',
      scenarioId: nextId,
      generation,
      shared: true,
      anchor: supervisor.anchor,
      personaId: 'owner',
    });
  } catch {
    if (candidate) await stopScenarioProcesses(candidate.processes);
    supervisor.scenarioId = nextId;
    supervisor.anchor = candidate?.scenario.anchor ?? supervisor.anchor;
    supervisor.failureCode = 'DEMO_LOAD_FAILED';
    supervisor.status = 'failed';
    error(response, 503, supervisor.failureCode);
  } finally {
    supervisor.lastLoadAt = Date.now();
    supervisor.busy = false;
  }
}

async function handleRequest(
  supervisor: Supervisor,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? '';
  const target = requestPath(request);
  if (
    !target ||
    method === 'CONNECT' ||
    header(request, 'upgrade') ||
    header(request, 'transfer-encoding')
  ) {
    error(response, 400, 'DEMO_INVALID_REQUEST');
    return;
  }
  if (!validHost(request, supervisor.origin)) {
    error(response, 403, 'DEMO_HOST_DENIED');
    return;
  }
  if (unsafeMethod(method) && !validUnsafeOrigin(request, supervisor.origin)) {
    error(response, 403, 'DEMO_ORIGIN_DENIED');
    return;
  }
  if (supervisor.stopping) {
    error(response, 503, 'DEMO_STOPPING');
    return;
  }
  if (target.path.startsWith('/__demo/')) {
    await handleControl(supervisor, request, response, target.path);
    return;
  }
  const workspace = supervisor.current;
  if (!workspace) {
    error(response, 503, 'DEMO_NOT_READY');
    return;
  }
  if (target.path === '/demo' && method === 'GET') {
    const done = trackFinancial(supervisor);
    try {
      if (supervisor.busy) {
        await proxy(supervisor, request, response, workspace);
        return;
      }
      const control = readControl(supervisor, request);
      const personaId =
        control?.session.generation === supervisor.generation &&
        personaCredentials(workspace, control.session.personaId)
          ? control.session.personaId
          : 'owner';
      const credentials = personaCredentials(workspace, personaId);
      const signedIn =
        supervisor.status === 'ready' &&
        credentials &&
        (await authorizedActor(supervisor, workspace, request)) === credentials.actorId;
      const cookies =
        supervisor.status === 'ready' && !signedIn
          ? await signInPersona(supervisor, workspace, personaId)
          : [];
      if (supervisor.busy || supervisor.current !== workspace) {
        error(response, 409, 'DEMO_STALE_GENERATION');
        return;
      }
      issueControl(supervisor, response, personaId);
      if (cookies.length > 0) appendCookies(response, cookies);
      await proxy(supervisor, request, response, workspace);
    } finally {
      done();
    }
    return;
  }
  if (supervisor.busy || supervisor.status !== 'ready') {
    if (method === 'GET' || method === 'HEAD') {
      if (target.path.startsWith('/_nuxt/') || target.path === '/favicon.ico') {
        await proxy(supervisor, request, response, workspace);
        return;
      }
    }
    error(response, 503, 'DEMO_FINANCIAL_UNAVAILABLE');
    return;
  }
  if (forbiddenProxyPath(method, target.path)) {
    error(response, 403, 'DEMO_OPERATION_DISABLED');
    return;
  }
  if (target.path.startsWith('/api/')) {
    const done = trackFinancial(supervisor);
    try {
      await proxy(supervisor, request, response, workspace);
    } finally {
      done();
    }
    return;
  }
  if (method === 'GET' || method === 'HEAD') {
    await proxy(supervisor, request, response, workspace);
    return;
  }
  error(response, 403, 'DEMO_OPERATION_DISABLED');
}

/** Starts a bound demo listener and one private authenticated scenario; failed seeds retain only the /demo shell. */
export async function startDemoServer(options: StartDemoServerOptions = {}): Promise<DemoServer> {
  const scenarioId = options.scenarioId ?? 'funded-purchase';
  if (!listScenarios().some(({ id }) => id === scenarioId))
    throw new Error('Unknown demo scenario ID');
  const host = options.host ?? LOOPBACK;
  const port = options.port ?? 3003;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid demo port');
  if (host !== LOOPBACK && host !== 'localhost' && host !== '::1' && !options.origin) {
    throw new Error('A non-loopback demo listener requires a configured HTTPS origin');
  }
  const webEntry = builtWebEntry();
  let supervisor: Supervisor;
  const listener = createServer((request, response) => {
    void handleRequest(supervisor, request, response).catch(() =>
      error(response, 503, 'DEMO_REQUEST_FAILED'),
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(port, host, resolve);
    });
    const address = listener.address() as AddressInfo | null;
    if (!address) throw new Error('Demo listener did not bind');
    const origin = validatePublicOrigin(options.origin ?? `http://${host}:${address.port}`, host);
    supervisor = {
      listener,
      secret: randomBytes(32),
      origin,
      host,
      webEntry,
      current: null,
      generation: 1,
      scenarioId,
      anchor: null,
      status: 'loading',
      failureCode: null,
      busy: true,
      activeFinancial: 0,
      drainFinancial: null,
      lastLoadAt: 0,
      stopping: false,
    };
    const handle = Object.freeze({ url: origin.origin });
    supervisors.set(handle, supervisor);
    let workspace: Workspace;
    try {
      workspace = await startWorkspace(supervisor, scenarioId, 1);
    } catch (failure) {
      await stopDemoServer(handle);
      throw failure;
    }
    supervisor.current = workspace;
    supervisor.anchor = workspace.scenario.anchor;
    try {
      await populateWorkspace(workspace, 1);
      await verifyNativeReadiness(supervisor, workspace);
      supervisor.status = 'ready';
    } catch {
      supervisor.failureCode = 'DEMO_LOAD_FAILED';
      supervisor.status = 'failed';
    } finally {
      supervisor.busy = false;
    }
    return handle;
  } catch (failure) {
    if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
    throw failure;
  }
}

/** Stops the exact owned listener and child processes represented by this handle. */
export async function stopDemoServer(handle: DemoServer): Promise<void> {
  const supervisor = supervisors.get(handle);
  if (!supervisor) throw new Error('Demo server handle is not owned');
  if (supervisor.stopping) return;
  supervisor.stopping = true;
  await new Promise<void>((resolve) => supervisor.listener.close(() => resolve()));
  if (supervisor.current) await stopScenarioProcesses(supervisor.current.processes);
  supervisors.delete(handle);
}

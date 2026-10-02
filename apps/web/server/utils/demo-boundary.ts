import { getHeader, getRequestPath, setResponseStatus, type H3Event } from 'h3';
import { timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, statSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { EventWithContext } from './workflow-store';

/** Header used only by the runner's private loopback setup/persona client. */
export const DEMO_INTERNAL_HEADER = 'x-balanceframe-demo-internal';

const DEMO_MANIFEST_VERSION = 1;
const DEMO_MANIFEST_MAX_BYTES = 64 * 1024;
const DEMO_DISABLED_CODE = 'DEMO_OPERATION_DISABLED';
const DEMO_DISABLED_MESSAGE = 'Demo operation disabled.';
const LOOPBACK_HOSTS: Record<string, true> = {
  '127.0.0.1': true,
  '::1': true,
  localhost: true,
};
const LOOPBACK_ADDRESSES: Record<string, true> = { '127.0.0.1': true, '::1': true };

/** Private manifest consumed by the web child at its trust boundary. */
export interface DemoManifest {
  readonly version: 1;
  readonly phase: 'setup' | 'ready';
  readonly generation: number;
  readonly origin: string;
  readonly actualUrl: string;
  readonly root: string;
  readonly authDbPath: string;
  readonly workflowDbPath: string;
  readonly connectionPath: string;
  readonly internalSecret: string;
  readonly budgetId: string | null;
  readonly actorIds: readonly string[];
}

type BoundaryEvent = EventWithContext & {
  method?: string;
  node?: {
    req?: {
      method?: string;
      url?: string;
      headers?: Record<string, string | string[] | undefined>;
      socket?: {
        localAddress?: string;
        remoteAddress?: string;
      };
    };
  };
};

type ManifestState =
  | { readonly kind: 'inactive' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'valid'; readonly manifest: DemoManifest };

type RuntimeConfig = Record<string, unknown>;

interface ConnectionConfig {
  readonly version?: unknown;
  readonly serverUrl?: unknown;
  readonly budgetId?: unknown;
  readonly budgetName?: unknown;
  readonly groupId?: unknown;
}

function readRuntimeConfig(event: BoundaryEvent): RuntimeConfig {
  try {
    return useRuntimeConfig(event as unknown as H3Event) as RuntimeConfig;
  } catch {
    return event.context.runtimeConfig ?? {};
  }
}

function configuredString(
  config: RuntimeConfig,
  key: string,
  environmentNames: readonly string[] = [],
): string {
  const configured = config[key];
  if (typeof configured === 'string' && configured.length > 0) return configured;
  for (const name of environmentNames) {
    const value = process.env[name];
    if (value && value.length > 0) return value;
  }
  return '';
}

function configuredBoolean(
  config: RuntimeConfig,
  key: string,
  environmentNames: readonly string[] = [],
): boolean {
  if (config[key] === true) return true;
  return environmentNames.some((name) => process.env[name] === 'true');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, maxLength = 4096): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
}

function absolutePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return null;
  if (!isAbsolute(value)) return null;
  const normalized = resolve(value);
  return normalized === value ? value : null;
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath.length > 0 &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function hasSymlinkComponent(pathname: string): boolean {
  const absolute = resolve(pathname);
  const parsedRoot = parse(absolute).root;
  let cursor = parsedRoot;
  for (const component of absolute.slice(parsedRoot.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    let stats: Stats;
    try {
      stats = lstatSync(cursor);
    } catch (error) {
      if (isFileNotFound(error)) break;
      return true;
    }
    if (stats.isSymbolicLink()) return true;
  }
  return false;
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function hasMode(stats: Stats, mode: number): boolean {
  return (stats.mode & 0o777) === mode;
}

function loopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS[normalized] === true;
}

function loopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  return LOOPBACK_ADDRESSES[normalized] === true;
}

function validOrigin(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (value !== parsed.origin && `${parsed.origin}/` !== value) return null;
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    if (parsed.protocol === 'http:') {
      if (!loopbackHost(parsed.hostname)) return null;
    } else if (parsed.protocol !== 'https:') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function validActualUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (value !== parsed.origin || parsed.protocol !== 'http:' || !loopbackHost(parsed.hostname))
      return null;
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

function safeEqual(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  if (providedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(providedBytes, expectedBytes);
}

function disabled(event: BoundaryEvent, status: 403 | 503): Record<string, unknown> {
  setResponseStatus(event as unknown as H3Event, status);
  return {
    schemaVersion: '1',
    requestId: 'demo-boundary',
    status: 'error',
    dataFreshness: null,
    authorization: null,
    result: null,
    error: {
      code: DEMO_DISABLED_CODE,
      message: DEMO_DISABLED_MESSAGE,
      retryable: false,
      reasonCodes: ['demo.operation_disabled'],
    },
  };
}

function manifestFromFile(manifestPath: string, config: RuntimeConfig): DemoManifest | null {
  if (!isAbsolute(manifestPath) || resolve(manifestPath) !== manifestPath) return null;
  if (hasSymlinkComponent(manifestPath)) return null;

  let manifestStats: Stats;
  try {
    manifestStats = lstatSync(manifestPath);
    if (!manifestStats.isFile() || !hasMode(manifestStats, 0o600)) return null;
    if (manifestStats.size > DEMO_MANIFEST_MAX_BYTES) return null;
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== DEMO_MANIFEST_VERSION) return null;

  const phase = parsed.phase;
  if (phase !== 'setup' && phase !== 'ready') return null;
  if (
    typeof parsed.generation !== 'number' ||
    !Number.isSafeInteger(parsed.generation) ||
    parsed.generation < 0
  ) {
    return null;
  }

  const origin = stringValue(parsed.origin, 2048);
  const actualUrl = stringValue(parsed.actualUrl, 2048);
  const root = absolutePath(parsed.root);
  const authDbPath = absolutePath(parsed.authDbPath);
  const workflowDbPath = absolutePath(parsed.workflowDbPath);
  const connectionPath = absolutePath(parsed.connectionPath);
  const internalSecret = stringValue(parsed.internalSecret, 4096);
  const budgetId = parsed.budgetId === null ? null : stringValue(parsed.budgetId, 1024);
  const actorIds = parsed.actorIds;
  if (
    !origin ||
    !actualUrl ||
    !root ||
    !authDbPath ||
    !workflowDbPath ||
    !connectionPath ||
    !internalSecret ||
    internalSecret.length < 32 ||
    (parsed.budgetId !== null && !budgetId) ||
    !Array.isArray(actorIds) ||
    actorIds.some((actorId) => !stringValue(actorId, 512))
  ) {
    return null;
  }

  const originUrl = validOrigin(origin);
  const actualUrlValue = validActualUrl(actualUrl);
  if (!originUrl || !actualUrlValue) return null;
  if (phase === 'setup' && (budgetId !== null || actorIds.length !== 0)) return null;
  if (phase === 'ready' && (!budgetId || actorIds.length === 0)) return null;
  if (new Set(actorIds).size !== actorIds.length) return null;

  const canonicalManifestPath = resolve(manifestPath);
  if (resolve(root) !== dirname(canonicalManifestPath)) return null;
  if (hasSymlinkComponent(root)) return null;
  let rootStats: Stats;
  try {
    rootStats = statSync(root);
  } catch {
    return null;
  }
  if (!rootStats.isDirectory() || !hasMode(rootStats, 0o700)) return null;
  if (
    !isWithin(root, authDbPath) ||
    !isWithin(root, workflowDbPath) ||
    !isWithin(root, connectionPath) ||
    [authDbPath, workflowDbPath, connectionPath].some(hasSymlinkComponent)
  ) {
    return null;
  }

  const configuredAuthDbPath = absolutePath(
    configuredString(config, 'authDbPath', ['NUXT_AUTH_DB_PATH', 'BALANCEFRAME_AUTH_DB_PATH']),
  );
  const configuredWorkflowDbPath = absolutePath(
    configuredString(config, 'workflowDbPath', [
      'NUXT_WORKFLOW_DB_PATH',
      'BALANCEFRAME_WORKFLOW_DB_PATH',
    ]),
  );
  const configuredConnectionPath = absolutePath(
    configuredString(config, 'connectionPath', [
      'BALANCEFRAME_CONFIG_PATH',
      'NUXT_CONNECTION_PATH',
    ]),
  );
  const credentialDirectory = absolutePath(
    configuredString(config, 'credentialDir', ['BALANCEFRAME_CREDENTIAL_DIR']),
  );
  const configuredActualUrl = configuredString(config, 'actualServerUrl', ['ACTUAL_SERVER_URL']);
  if (
    !configuredAuthDbPath ||
    !configuredWorkflowDbPath ||
    !configuredConnectionPath ||
    !credentialDirectory ||
    !isWithin(root, credentialDirectory) ||
    hasSymlinkComponent(credentialDirectory) ||
    configuredAuthDbPath !== authDbPath ||
    configuredWorkflowDbPath !== workflowDbPath ||
    configuredConnectionPath !== connectionPath ||
    configuredActualUrl !== actualUrl ||
    !configuredActualUrl
  ) {
    return null;
  }

  let credentialsStats: Stats;
  try {
    credentialsStats = statSync(credentialDirectory);
  } catch {
    return null;
  }
  if (!credentialsStats.isDirectory() || !hasMode(credentialsStats, 0o700)) return null;

  if (!configuredBoolean(config, 'reviewAndApply', ['NUXT_REVIEW_AND_APPLY'])) return null;

  if (phase === 'ready') {
    let connection: ConnectionConfig;
    try {
      connection = JSON.parse(readFileSync(connectionPath, 'utf8')) as ConnectionConfig;
    } catch {
      return null;
    }
    if (
      connection.version !== 1 ||
      connection.serverUrl !== actualUrl ||
      connection.budgetId !== budgetId ||
      typeof connection.budgetName !== 'string' ||
      connection.budgetName.length === 0 ||
      typeof connection.groupId !== 'string' ||
      connection.groupId.length === 0
    ) {
      return null;
    }
  }

  return {
    version: 1,
    phase,
    generation: parsed.generation,
    origin,
    actualUrl,
    root,
    authDbPath,
    workflowDbPath,
    connectionPath,
    internalSecret,
    budgetId,
    actorIds: [...actorIds] as string[],
  };
}

function readManifest(config: RuntimeConfig): ManifestState {
  const manifestPath = configuredString(config, 'demoManifestPath', ['NUXT_DEMO_MANIFEST_PATH']);
  if (!manifestPath) return { kind: 'inactive' };
  const manifest = manifestFromFile(manifestPath, config);
  return manifest ? { kind: 'valid', manifest } : { kind: 'invalid' };
}

function requestMethod(event: BoundaryEvent): string {
  const method = event.node?.req?.method ?? event.method;
  return typeof method === 'string' && method.length > 0 ? method.toUpperCase() : 'GET';
}

function requestTargetIsUnsafe(event: BoundaryEvent): boolean {
  const target = event.node?.req?.url;
  if (!target) return false;
  return target.startsWith('//') || /^[a-z][a-z\d+.-]*:\/\//i.test(target);
}

function requestIsUpgrade(event: BoundaryEvent): boolean {
  const upgrade = getHeader(event as unknown as H3Event, 'upgrade');
  const connection = getHeader(event as unknown as H3Event, 'connection');
  return (
    Boolean(upgrade) ||
    (typeof connection === 'string' && /(^|,)\s*upgrade\s*(,|$)/i.test(connection))
  );
}

function internalRequest(event: BoundaryEvent, manifest: DemoManifest): boolean {
  const provided = getHeader(event as unknown as H3Event, DEMO_INTERNAL_HEADER);
  const req = event.node?.req;
  const socket = req?.socket;
  const valid =
    typeof provided === 'string' &&
    loopbackAddress(socket?.localAddress) &&
    loopbackAddress(socket?.remoteAddress) &&
    safeEqual(provided, manifest.internalSecret);

  // The supervisor/proxy must remove this header before forwarding browser traffic.
  if (req?.headers) {
    delete req.headers[DEMO_INTERNAL_HEADER];
    delete req.headers['X-BalanceFrame-Demo-Internal'];
  }
  return valid;
}

function validUnsafeRequest(
  event: BoundaryEvent,
  manifest: DemoManifest,
  internal: boolean,
): boolean {
  const origin = getHeader(event as unknown as H3Event, 'origin');
  const host = getHeader(event as unknown as H3Event, 'host');
  const forwardedHost = getHeader(event as unknown as H3Event, 'x-forwarded-host');
  const forwardedProto = getHeader(event as unknown as H3Event, 'x-forwarded-proto');
  let originUrl: URL;
  try {
    originUrl = new URL(manifest.origin);
  } catch {
    return false;
  }
  const directHostValid = host === originUrl.host;
  const forwardedHostValid =
    internal &&
    forwardedHost === originUrl.host &&
    forwardedProto === originUrl.protocol.slice(0, -1);
  return (
    origin === originUrl.origin && (directHostValid || forwardedHostValid) && origin !== 'null'
  );
}

function pathMatches(path: string, pattern: RegExp): boolean {
  return pattern.test(path);
}

const APPROVED_FINANCIAL_WRITES: readonly { method: string; path: RegExp }[] = [
  { method: 'POST', path: /^\/api\/spend-sessions$/ },
  { method: 'PUT', path: /^\/api\/spend-sessions\/[^/]+$/ },
  { method: 'DELETE', path: /^\/api\/spend-sessions\/[^/]+$/ },
  { method: 'POST', path: /^\/api\/spend-sessions\/[^/]+\/completions$/ },
  {
    method: 'POST',
    path: /^\/api\/spend-sessions\/[^/]+\/completions\/[^/]+\/(?:approve|execute|reconcile)$/,
  },
  { method: 'PUT', path: /^\/api\/liquidity\/(?:policy|observations|grants|preferences)$/ },
  { method: 'POST', path: /^\/api\/liquidity\/claims$/ },
  { method: 'POST', path: /^\/api\/liquidity\/claims\/[^/]+\/release$/ },
  { method: 'POST', path: /^\/api\/liquidity\/reallocation-preview$/ },
  { method: 'POST', path: /^\/api\/transfer\/(?:preview|propose)$/ },
  {
    method: 'POST',
    path: /^\/api\/transfer\/[^/]+\/(?:approve|report-initiated|reconcile|cancel|instructions)$/,
  },
];

function approvedFinancialWrite(path: string, method: string): boolean {
  return APPROVED_FINANCIAL_WRITES.some(
    (entry) => entry.method === method && pathMatches(path, entry.path),
  );
}

function setupWrite(path: string, method: string): boolean {
  return (
    (method === 'POST' &&
      (path === '/api/registration/bootstrap' ||
        path === '/api/invitations' ||
        path === '/api/invitations/redeem' ||
        path === '/api/connection')) ||
    approvedFinancialWrite(path, method)
  );
}

function externalRead(path: string, method: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (path === '/api/connection' || path.startsWith('/api/connection/')) return false;
  if (path === '/api/auth' || path.startsWith('/api/auth/'))
    return path === '/api/auth/get-session';
  return true;
}

function externalWrite(path: string, method: string): boolean {
  if (method === 'POST' && path === '/api/auth/sign-out') return true;
  return approvedFinancialWrite(path, method);
}

/**
 * Enforce the runner-owned demo trust boundary before API public-route or auth
 * exemptions. Undefined means the normal application path may continue.
 */
export function enforceDemoBoundary(event: EventWithContext): Record<string, unknown> | undefined {
  const boundaryEvent = event as BoundaryEvent;
  const config = readRuntimeConfig(boundaryEvent);
  const state = readManifest(config);
  if (state.kind === 'inactive') return undefined;

  if (requestTargetIsUnsafe(boundaryEvent) || requestIsUpgrade(boundaryEvent)) {
    return disabled(boundaryEvent, 403);
  }

  const path = getRequestPath(boundaryEvent as unknown as H3Event);
  if (!path.startsWith('/api/')) return undefined;
  if (state.kind === 'invalid') return disabled(boundaryEvent, 503);

  const manifest = state.manifest;
  const method = requestMethod(boundaryEvent);
  const internal = internalRequest(boundaryEvent, manifest);
  const unsafe = method !== 'GET' && method !== 'HEAD';
  if (unsafe && !validUnsafeRequest(boundaryEvent, manifest, internal)) {
    return disabled(boundaryEvent, 403);
  }
  if (method === 'CONNECT') return disabled(boundaryEvent, 403);

  if (externalRead(path, method) && (manifest.phase === 'ready' || internal)) return undefined;
  if (externalWrite(path, method) && !internal && manifest.phase === 'ready') return undefined;

  if (internal) {
    // The body is deliberately not parsed in middleware; the supervisor owns
    // fictional credential selection and the sign-in result remains subject to
    // Better Auth. This boundary only accepts the private loopback transport.
    if (path === '/api/auth/sign-in/email' && method === 'POST') return undefined;
    if (manifest.phase === 'setup' && setupWrite(path, method)) return undefined;
  }

  return disabled(boundaryEvent, 403);
}

import {
  ActualConnector,
  createDefaultActualClient,
  EnvCredentialStore,
} from '@balanceframe/actual-adapter';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ApplicationError, ReasonCodes } from './errors.js';

export interface ConnectionConfig {
  readonly version: 1;
  readonly serverUrl: string;
  readonly budgetId: string;
  readonly budgetName: string;
  readonly groupId: string;
}

interface Credentials {
  readonly serverUrl: string;
  readonly secretKey: string;
  readonly budgetPassword?: string;
}

interface BudgetInfo {
  readonly id: string;
  readonly groupId: string;
  readonly name: string;
  readonly encrypted: boolean;
}

interface Connector {
  connect(credentials?: Credentials): Promise<BudgetInfo[]>;
  selectBudget(id: string, password?: string): Promise<BudgetInfo>;
  synchronize(options?: { readonly refresh?: boolean }): Promise<unknown>;
  disconnect(): Promise<void>;
}

interface CredentialStore {
  load(): Promise<Credentials | null>;
  store(credentials: Credentials): Promise<void>;
}

export interface ConnectionManagerOptions {
  readonly configPath?: string;
  readonly credentialStore: CredentialStore;
  readonly connectorFactory: (credentials: Credentials) => Promise<Connector>;
  readonly readFile?: (path: string) => Promise<string | null>;
  readonly writeFile?: (path: string, value: string) => Promise<void>;
}

export interface ConnectedBudget {
  /** Exact selected-budget configuration used while holding the lifecycle lock. */
  readonly config: ConnectionConfig;
  readonly budget: BudgetInfo;
  readonly connector: Connector;
  readonly synchronization: unknown;
}

export interface ConnectionUseOptions {
  /** Disconnect and discard the connector after the scoped operation, including on failure. */
  readonly dispose?: boolean;
}

/** Persists selected-budget metadata and serializes access to the process-global Actual API. */
export class ConnectionManager {
  private readonly configPath: string;
  private readonly credentialStore: CredentialStore;
  private readonly connectorFactory: ConnectionManagerOptions['connectorFactory'];
  private readonly readConfigFile: (path: string) => Promise<string | null>;
  private readonly writeConfigFile: (path: string, value: string) => Promise<void>;
  private connectedBudget: ConnectedBudget | null = null;
  private connectedConfig: ConnectionConfig | null = null;
  private connectedCredentials: Credentials | null = null;
  private restorePromise: Promise<ConnectedBudget> | null = null;
  private quarantinedConnector: Connector | null = null;

  constructor(options: ConnectionManagerOptions) {
    this.configPath = options.configPath ?? `${process.env.HOME ?? '.'}/.balanceframe/config.json`;
    this.credentialStore = options.credentialStore;
    this.connectorFactory = options.connectorFactory;
    this.readConfigFile =
      options.readFile ??
      (async (path) => {
        try {
          return await readFile(path, 'utf8');
        } catch (error: unknown) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
          throw error;
        }
      });
    this.writeConfigFile =
      options.writeFile ??
      (async (path, value) => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, value, { mode: 0o600 });
      });
  }

  /** Connect using credentials and persist the selected budget without secrets. */
  async connect(input: { budgetId: string; credentials?: Credentials }): Promise<ConnectedBudget> {
    return this.runWithLifecycle(async () => {
      await this.disconnectConnected();
      actualLifecycleState.owner = this;
      const credentials = input.credentials ?? (await this.credentialStore.load());
      if (!credentials) throw new Error('No Actual credentials configured.');
      let connector: Connector | null = null;
      try {
        connector = await this.connectorFactory(credentials);
        const budgets = await connector.connect(credentials);
        const budget = budgets.find(
          (candidate) => candidate.id === input.budgetId || candidate.groupId === input.budgetId,
        );
        if (!budget) throw new Error(`Budget "${input.budgetId}" not found on server.`);
        const selected = await connector.selectBudget(
          budget.id || budget.groupId,
          credentials.budgetPassword,
        );
        const synchronization = await connector.synchronize({ refresh: false });
        const config: ConnectionConfig = {
          version: 1,
          serverUrl: credentials.serverUrl,
          budgetId: selected.id || selected.groupId,
          budgetName: selected.name,
          groupId: selected.groupId,
        };
        await this.saveConfig(config);
        const connected = { budget: selected, config, connector, synchronization };
        this.connectedBudget = connected;
        this.connectedConfig = config;
        this.connectedCredentials = credentials;
        return connected;
      } catch (error) {
        let cleanupFailed = false;
        if (connector) {
          try {
            await this.disconnectConnector(connector);
          } catch (cleanupError) {
            cleanupFailed = true;
            console.error('Failed to clean up newly created Actual connector:', cleanupError);
          }
        }
        if (!cleanupFailed && actualLifecycleState.owner === this) actualLifecycleState.owner = null;
        throw error;
      }
    });
  }

  /** Discover available Actual budgets, then disconnect the temporary client. */
  async listBudgets(credentials?: Credentials): Promise<BudgetInfo[]> {
    return this.runWithLifecycle(async () => {
      await this.disconnectConnected();
      actualLifecycleState.owner = this;
      const resolvedCredentials = credentials ?? (await this.credentialStore.load());
      if (!resolvedCredentials) throw new Error('No Actual credentials configured.');
      const connector = await this.connectorFactory(resolvedCredentials);
      let budgets: BudgetInfo[];
      try {
        budgets = await connector.connect(resolvedCredentials);
      } catch (error) {
        let cleanupFailed = false;
        try {
          await this.disconnectConnector(connector);
        } catch (cleanupError) {
          cleanupFailed = true;
          console.error(
            'Failed to clean up Actual connector after budget discovery failure:',
            cleanupError,
          );
        }
        if (!cleanupFailed && actualLifecycleState.owner === this) actualLifecycleState.owner = null;
        throw error;
      }

      try {
        await this.disconnectConnector(connector);
      } finally {
        if (!this.quarantinedConnector && actualLifecycleState.owner === this) {
          actualLifecycleState.owner = null;
        }
      }
      return budgets;
    });
  }

  /**
   * Restore the configured budget, synchronizing it before returning the connector.
   *
   * Single-command compatibility API. Concurrent server callers must use
   * `withConnection()` so the connector cannot outlive the global lifecycle lock.
   */
  async restore(): Promise<ConnectedBudget> {
    if (this.restorePromise) return this.restorePromise;

    const pending = this.runWithLifecycle(() => this.restoreConfiguredBudget());
    this.restorePromise = pending;
    try {
      return await pending;
    } finally {
      if (this.restorePromise === pending) this.restorePromise = null;
    }
  }

  /** Run an operation while holding exclusive process-wide access to the selected Actual budget. */
  async withConnection<T>(
    operation: (connected: ConnectedBudget) => Promise<T>,
    options: ConnectionUseOptions = {},
  ): Promise<T> {
    return this.runWithLifecycle(async () => {
      const connected = await this.restoreConfiguredBudget();
      try {
        return await operation(connected);
      } finally {
        if (options.dispose) {
          try {
            await this.disconnectConnected();
          } catch (error) {
            console.error('Failed to dispose scoped Actual connection after operation:', error);
          }
        }
      }
    });
  }

  /** Disconnect and discard this manager's active connector. */
  async disconnect(): Promise<void> {
    await runActualLifecycleExclusive(() => this.disconnectConnected());
  }

  private async restoreConfiguredBudget(): Promise<ConnectedBudget> {
    const config = await this.loadConfig();
    if (!config) {
      await this.disconnectConnected();
      throw new ApplicationError({
        code: 'not_connected',
        message: 'No BalanceFrame connection configured. Run connect first.',
        reasonCodes: [ReasonCodes.MISSING_LEDGER_CONFIG],
        retryable: true,
      });
    }
    const credentials = await this.credentialStore.load();
    if (!credentials) {
      await this.disconnectConnected();
      throw new Error('No Actual credentials configured.');
    }
    if (credentials.serverUrl !== config.serverUrl) {
      await this.disconnectConnected();
      throw new Error('Stored credentials do not match the configured server.');
    }

    if (
      this.connectedBudget &&
      this.connectedConfig &&
      this.connectedCredentials &&
      sameConfig(this.connectedConfig, config) &&
      sameCredentials(this.connectedCredentials, credentials)
    ) {
      try {
        const synchronization = await this.connectedBudget.connector.synchronize();
        const connected = { ...this.connectedBudget, synchronization };
        this.connectedBudget = connected;
        return connected;
      } catch (error) {
        try {
          await this.disconnectConnected();
        } catch (cleanupError) {
          console.error(
            'Failed to clean up Actual connector after synchronization failure:',
            cleanupError,
          );
        }
        throw error;
      }
    }

    await this.disconnectConnected();
    actualLifecycleState.owner = this;
    let connector: Connector | null = null;
    try {
      connector = await this.connectorFactory(credentials);
      await connector.connect(credentials);
      const budget = await connector.selectBudget(config.budgetId, credentials.budgetPassword);
      const synchronization = await connector.synchronize({ refresh: false });
      const connected = { budget, config, connector, synchronization };
      this.connectedBudget = connected;
      this.connectedConfig = config;
      this.connectedCredentials = credentials;
      return connected;
    } catch (error) {
      let cleanupFailed = false;
      if (connector) {
        try {
          await this.disconnectConnector(connector);
        } catch (cleanupError) {
          cleanupFailed = true;
          console.error('Failed to clean up newly created Actual connector:', cleanupError);
        }
      }
      if (!cleanupFailed && actualLifecycleState.owner === this) actualLifecycleState.owner = null;
      throw error;
    }
  }

  /** Read and validate the selected-budget configuration; null means the file is missing, while invalid or unreadable content throws. */
  async loadConfig(): Promise<ConnectionConfig | null> {
    const raw = await this.readConfigFile(this.configPath);
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<ConnectionConfig>;
    if (
      value.version !== 1 ||
      !value.serverUrl ||
      !value.budgetId ||
      !value.budgetName ||
      !value.groupId
    ) {
      throw new Error('Invalid BalanceFrame connection configuration.');
    }
    return value as ConnectionConfig;
  }

  private async runWithLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    return runActualLifecycleExclusive(async () => {
      const owner = actualLifecycleState.owner;
      if (owner && (owner !== this || owner.quarantinedConnector)) {
        await owner.disconnectConnected();
      } else if (this.quarantinedConnector) {
        await this.disconnectConnected();
      }
      actualLifecycleState.owner = this;
      return operation();
    });
  }

  private async disconnectConnected(): Promise<void> {
    const connected = this.connectedBudget;
    const quarantined = this.quarantinedConnector;
    if (quarantined) await this.disconnectConnector(quarantined);
    if (connected && connected.connector !== quarantined) {
      await this.disconnectConnector(connected.connector);
    }
    this.connectedBudget = null;
    this.connectedConfig = null;
    this.connectedCredentials = null;
    if (actualLifecycleState.owner === this) actualLifecycleState.owner = null;
  }

  private async disconnectConnector(connector: Connector): Promise<void> {
    this.quarantinedConnector = connector;
    actualLifecycleState.owner = this;
    await connector.disconnect();
    if (this.quarantinedConnector === connector) this.quarantinedConnector = null;
  }

  private async saveConfig(config: ConnectionConfig): Promise<void> {
    await this.writeConfigFile(this.configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
}

function sameConfig(left: ConnectionConfig, right: ConnectionConfig): boolean {
  return (
    left.version === right.version &&
    left.serverUrl === right.serverUrl &&
    left.budgetId === right.budgetId &&
    left.groupId === right.groupId
  );
}

function sameCredentials(left: Credentials, right: Credentials): boolean {
  return (
    left.serverUrl === right.serverUrl &&
    left.secretKey === right.secretKey &&
    left.budgetPassword === right.budgetPassword
  );
}

interface ActualLifecycleState {
  tail: Promise<void>;
  owner: ConnectionManager | null;
}

const actualLifecycleKey = Symbol.for('balanceframe.actual-lifecycle-state');
const lifecycleRegistry = globalThis as typeof globalThis &
  Record<symbol, ActualLifecycleState | undefined>;
const actualLifecycleState = lifecycleRegistry[actualLifecycleKey] ?? {
  tail: Promise.resolve(),
  owner: null,
};
lifecycleRegistry[actualLifecycleKey] = actualLifecycleState;

async function runActualLifecycleExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const predecessor = actualLifecycleState.tail;
  let release: (() => void) | undefined;
  actualLifecycleState.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;
  try {
    return await operation();
  } finally {
    release?.();
  }
}

const managerRegistryKey = Symbol.for('balanceframe.default-connection-managers');
const managerRegistry = globalThis as typeof globalThis &
  Record<symbol, Map<string, ConnectionManager> | undefined>;
const defaultManagers = managerRegistry[managerRegistryKey] ?? new Map<string, ConnectionManager>();
managerRegistry[managerRegistryKey] = defaultManagers;

/** Create a production connection manager using fixture-compatible environment credentials. */
export function createDefaultConnectionManager(options?: {
  configPath?: string;
}): ConnectionManager {
  const configPath = options?.configPath ?? `${process.env.HOME ?? '.'}/.balanceframe/config.json`;
  const existing = defaultManagers.get(configPath);
  if (existing) return existing;

  const manager = new ConnectionManager({
    configPath,
    credentialStore: new EnvCredentialStore(),
    connectorFactory: async () =>
      new ActualConnector({
        client: await createDefaultActualClient(),
        credentialStore: new EnvCredentialStore(),
        mode: 'observe',
      }),
  });
  defaultManagers.set(configPath, manager);
  return manager;
}

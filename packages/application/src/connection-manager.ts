import { ActualConnector, createDefaultActualClient, EnvCredentialStore } from '@balanceframe/actual-adapter';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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
  synchronize(): Promise<unknown>;
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
  readonly budget: BudgetInfo;
  readonly connector: Connector;
  readonly synchronization: unknown;
}

/** Persists selected-budget metadata and restores an authenticated Actual connector. */
export class ConnectionManager {
  private readonly configPath: string;
  private readonly credentialStore: CredentialStore;
  private readonly connectorFactory: ConnectionManagerOptions['connectorFactory'];
  private readonly readConfigFile: (path: string) => Promise<string | null>;
  private readonly writeConfigFile: (path: string, value: string) => Promise<void>;

  constructor(options: ConnectionManagerOptions) {
    this.configPath = options.configPath ?? `${process.env.HOME ?? '.'}/.balanceframe/config.json`;
    this.credentialStore = options.credentialStore;
    this.connectorFactory = options.connectorFactory;
    this.readConfigFile = options.readFile ?? (async path => {
      try { return await readFile(path, 'utf8'); } catch { return null; }
    });
    this.writeConfigFile = options.writeFile ?? (async (path, value) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, value, { mode: 0o600 });
    });
  }

  /** Connect using credentials and persist the selected budget without secrets. */
  async connect(input: { budgetId: string; credentials?: Credentials }): Promise<ConnectedBudget> {
    const credentials = input.credentials ?? await this.credentialStore.load();
    if (!credentials) throw new Error('No Actual credentials configured.');
    const connector = await this.connectorFactory(credentials);
    const budgets = await connector.connect(credentials);
    const budget = budgets.find(candidate =>
      candidate.id === input.budgetId || candidate.groupId === input.budgetId,
    );
    if (!budget) throw new Error(`Budget "${input.budgetId}" not found on server.`);
    const selected = await connector.selectBudget(budget.id || budget.groupId, credentials.budgetPassword);
    const synchronization = await connector.synchronize();
    await this.saveConfig({
      version: 1,
      serverUrl: credentials.serverUrl,
      budgetId: selected.id || selected.groupId,
      budgetName: selected.name,
      groupId: selected.groupId,
    });
    return { budget: selected, connector, synchronization };
  }
 
  /** Discover available Actual budgets without selecting or mutating one. */
  async listBudgets(credentials?: Credentials): Promise<BudgetInfo[]> {
    const resolvedCredentials = credentials ?? await this.credentialStore.load();
    if (!resolvedCredentials) throw new Error('No Actual credentials configured.');
    const connector = await this.connectorFactory(resolvedCredentials);
    return connector.connect(resolvedCredentials);
  }

  /** Restore the configured budget, synchronizing it before returning the connector. */
  async restore(): Promise<ConnectedBudget> {
    const config = await this.loadConfig();
    if (!config) throw new Error('No BalanceFrame connection configured. Run connect first.');
    const credentials = await this.credentialStore.load();
    if (!credentials) throw new Error('No Actual credentials configured.');
    if (credentials.serverUrl !== config.serverUrl) {
      throw new Error('Stored credentials do not match the configured server.');
    }
    const connector = await this.connectorFactory(credentials);
    await connector.connect(credentials);
    const budget = await connector.selectBudget(config.budgetId, credentials.budgetPassword);
    const synchronization = await connector.synchronize();
    return { budget, connector, synchronization };
  }

  /** Read and validate the selected-budget configuration, or return null. */
  async loadConfig(): Promise<ConnectionConfig | null> {
    const raw = await this.readConfigFile(this.configPath);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ConnectionConfig>;
    if (value.version !== 1 || !value.serverUrl || !value.budgetId || !value.budgetName || !value.groupId) {
      throw new Error('Invalid BalanceFrame connection configuration.');
    }
    return value as ConnectionConfig;
  }

  private async saveConfig(config: ConnectionConfig): Promise<void> {
    await this.writeConfigFile(this.configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
}

/** Create a production connection manager using fixture-compatible environment credentials. */
export function createDefaultConnectionManager(options?: { configPath?: string }): ConnectionManager {
  return new ConnectionManager({
    configPath: options?.configPath,
    credentialStore: new EnvCredentialStore(),
    connectorFactory: async () => new ActualConnector({
      client: await createDefaultActualClient(),
      credentialStore: new EnvCredentialStore(),
      mode: 'observe',
    }),
  });
}

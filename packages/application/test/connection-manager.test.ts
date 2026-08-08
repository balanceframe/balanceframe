import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConnectionManager } from '../src/connection-manager.js';

function fakeConnector() {
  return {
    connect: async () => [{ id: 'budget-1', groupId: 'group-1', name: 'Test Budget', encrypted: false }],
    selectBudget: async () => ({ id: 'budget-1', groupId: 'group-1', name: 'Test Budget', encrypted: false }),
    synchronize: async () => ({
      snapshot: { transactions: [], categories: [] },
      health: { state: 'healthy' },
      watermark: {},
    }),
  };
}

function managerWithDefaultReader(configPath: string): ConnectionManager {
  return new ConnectionManager({
    configPath,
    writeFile: async () => {},
    credentialStore: {
      load: async () => ({ serverUrl: 'http://actual', secretKey: 'secret' }),
      store: async () => {},
    },
    connectorFactory: async () => fakeConnector(),
  });
}

describe('ConnectionManager', () => {
  it('persists selected budget metadata without persisting secrets', async () => {
    const files = new Map<string, string>();
    const manager = new ConnectionManager({
      configPath: '/tmp/config.json',
      readFile: async path => files.get(path) ?? null,
      writeFile: async (path, value) => { files.set(path, value); },
      credentialStore: {
        load: async () => ({ serverUrl: 'http://actual', secretKey: 'secret' }),
        store: async () => {},
      },
      connectorFactory: async () => fakeConnector(),
    });

    const result = await manager.connect({ budgetId: 'budget-1' });
    expect(result.budget.id).toBe('budget-1');
    const config = JSON.parse(files.get('/tmp/config.json')!);
    expect(config.budgetId).toBe('budget-1');
    expect(config.secretKey).toBeUndefined();
  });
 
  it('accepts a server group ID when the API omits the local budget ID', async () => {
    const files = new Map<string, string>();
    const manager = new ConnectionManager({
      configPath: '/tmp/config.json',
      readFile: async path => files.get(path) ?? null,
      writeFile: async (path, value) => { files.set(path, value); },
      credentialStore: {
        load: async () => ({ serverUrl: 'http://actual', secretKey: 'secret' }),
        store: async () => {},
      },
      connectorFactory: async () => ({
        connect: async () => [{ id: '', groupId: 'group-1', name: 'Test Budget', encrypted: false }],
        selectBudget: async id => ({ id, groupId: 'group-1', name: 'Test Budget', encrypted: false }),
        synchronize: async () => ({ snapshot: { transactions: [], categories: [] } }),
      }),
    });
 
    const result = await manager.connect({ budgetId: 'group-1' });
    expect(result.budget.groupId).toBe('group-1');
  });

  it('loads configuration and synchronizes the selected budget', async () => {
    const files = new Map([['/tmp/config.json', JSON.stringify({ version: 1, serverUrl: 'http://actual', budgetId: 'budget-1', budgetName: 'Test Budget', groupId: 'group-1' })]]);
    let synchronized = false;
    const connector = { ...fakeConnector(), synchronize: async () => { synchronized = true; return { snapshot: { transactions: [], categories: [] }, health: { state: 'healthy' }, watermark: {} }; } };
    const manager = new ConnectionManager({
      configPath: '/tmp/config.json',
      readFile: async path => files.get(path) ?? null,
      writeFile: async () => {},
      credentialStore: { load: async () => ({ serverUrl: 'http://actual', secretKey: 'secret' }), store: async () => {} },
      connectorFactory: async () => connector,
    });

    const result = await manager.restore();
    expect(result.budget.name).toBe('Test Budget');
    expect(synchronized).toBe(true);
  });

  it('treats only an absent production config as unconfigured', async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), 'balanceframe-config-'));
    try {
      const manager = managerWithDefaultReader(join(fixtureDirectory, 'missing.json'));

      await expect(manager.loadConfig()).resolves.toBeNull();
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it('rejects a zero-byte production config instead of treating it as absent', async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), 'balanceframe-config-'));
    const configPath = join(fixtureDirectory, 'config.json');
    try {
      await writeFile(configPath, '');
      const manager = managerWithDefaultReader(configPath);

      await expect(manager.loadConfig()).rejects.toThrow(SyntaxError);
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it('propagates a non-ENOENT production config read failure', async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), 'balanceframe-config-'));
    const configDirectory = join(fixtureDirectory, 'config-directory');
    try {
      await mkdir(configDirectory);
      const manager = managerWithDefaultReader(configDirectory);

      await expect(manager.loadConfig()).rejects.toMatchObject({ code: 'EISDIR' });
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });
  it('reports that a connection must be selected when configuration is absent', async () => {
    const manager = new ConnectionManager({
      configPath: '/tmp/missing-config.json',
      readFile: async () => null,
      writeFile: async () => {},
      credentialStore: {
        load: async () => ({ serverUrl: 'http://actual', secretKey: 'secret' }),
        store: async () => {},
      },
      connectorFactory: async () => fakeConnector(),
    });

    await expect(manager.restore()).rejects.toThrow(
      'No BalanceFrame connection configured. Run connect first.',
    );
  });
});

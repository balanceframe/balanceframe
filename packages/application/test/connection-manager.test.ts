import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { ConnectionManager, createDefaultConnectionManager } from '../src/connection-manager.js';

function fakeConnector() {
  return {
    connect: async () => [
      { id: 'budget-1', groupId: 'group-1', name: 'Test Budget', encrypted: false },
    ],
    selectBudget: async () => ({
      id: 'budget-1',
      groupId: 'group-1',
      name: 'Test Budget',
      encrypted: false,
    }),
    synchronize: async () => ({
      snapshot: { transactions: [], categories: [] },
      health: { state: 'healthy' },
      watermark: {},
    }),
    disconnect: async () => {},
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

function managerWithDisconnect(disconnect: (connectorNumber: number) => Promise<void>): {
  manager: ConnectionManager;
  connectorFactory: Mock;
} {
  let connectorCount = 0;
  const connectorFactory = vi.fn(async () => {
    const connectorNumber = ++connectorCount;
    return { ...fakeConnector(), disconnect: () => disconnect(connectorNumber) };
  });
  return {
    manager: new ConnectionManager({
      configPath: '/tmp/scoped-disconnect.json',
      readFile: async () =>
        JSON.stringify({
          version: 1,
          serverUrl: 'http://actual',
          budgetId: 'budget-1',
          budgetName: 'Test Budget',
          groupId: 'group-1',
        }),
      writeFile: async () => {},
      credentialStore: {
        load: async () => ({ serverUrl: 'http://actual', secretKey: 'secret' }),
        store: async () => {},
      },
      connectorFactory,
    }),
    connectorFactory,
  };
}

describe('ConnectionManager', () => {
  it('persists selected budget metadata without persisting secrets', async () => {
    const files = new Map<string, string>();
    const manager = new ConnectionManager({
      configPath: '/tmp/config.json',
      readFile: async (path) => files.get(path) ?? null,
      writeFile: async (path, value) => {
        files.set(path, value);
      },
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
      readFile: async (path) => files.get(path) ?? null,
      writeFile: async (path, value) => {
        files.set(path, value);
      },
      credentialStore: {
        load: async () => ({ serverUrl: 'http://actual', secretKey: 'secret' }),
        store: async () => {},
      },
      connectorFactory: async () => ({
        connect: async () => [
          { id: '', groupId: 'group-1', name: 'Test Budget', encrypted: false },
        ],
        selectBudget: async (id) => ({
          id,
          groupId: 'group-1',
          name: 'Test Budget',
          encrypted: false,
        }),
        synchronize: async () => ({ snapshot: { transactions: [], categories: [] } }),
        disconnect: async () => {},
      }),
    });

    const result = await manager.connect({ budgetId: 'group-1' });
    expect(result.budget.groupId).toBe('group-1');
  });

  it('disconnects a newly created connector when connection selection fails', async () => {
    const disconnect = vi.fn(async () => {});
    const manager = new ConnectionManager({
      configPath: '/tmp/config.json',
      readFile: async () => null,
      writeFile: async () => {},
      credentialStore: {
        load: async () => ({ serverUrl: 'http://actual', secretKey: 'secret' }),
        store: async () => {},
      },
      connectorFactory: async () => ({
        ...fakeConnector(),
        selectBudget: async () => {
          throw new Error('budget selection failed');
        },
        disconnect,
      }),
    });

    await expect(manager.connect({ budgetId: 'budget-1' })).rejects.toThrow(
      'budget selection failed',
    );
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('loads configuration and synchronizes the selected budget', async () => {
    const files = new Map([
      [
        '/tmp/config.json',
        JSON.stringify({
          version: 1,
          serverUrl: 'http://actual',
          budgetId: 'budget-1',
          budgetName: 'Test Budget',
          groupId: 'group-1',
        }),
      ],
    ]);
    const synchronize = vi.fn(async () => ({
      snapshot: { transactions: [], categories: [] },
      health: { state: 'healthy' },
      watermark: {},
    }));
    const connector = { ...fakeConnector(), synchronize };
    const manager = new ConnectionManager({
      configPath: '/tmp/config.json',
      readFile: async (path) => files.get(path) ?? null,
      writeFile: async () => {},
      credentialStore: {
        load: async () => ({ serverUrl: 'http://actual', secretKey: 'secret' }),
        store: async () => {},
      },
      connectorFactory: async () => connector,
    });

    const result = await manager.restore();
    expect(result.budget.name).toBe('Test Budget');
    expect(synchronize).toHaveBeenCalledWith({ refresh: false });
  });

  it('deduplicates concurrent restores onto one connector lifecycle', async () => {
    const files = new Map([
      [
        '/tmp/config.json',
        JSON.stringify({
          version: 1,
          serverUrl: 'http://actual',
          budgetId: 'budget-1',
          budgetName: 'Test Budget',
          groupId: 'group-1',
        }),
      ],
    ]);
    let connectorCreations = 0;
    let releaseConnection: (() => void) | undefined;
    const connectionGate = new Promise<void>((resolve) => {
      releaseConnection = resolve;
    });
    const connector = {
      ...fakeConnector(),
      connect: async () => {
        await connectionGate;
        return fakeConnector().connect();
      },
    };
    const manager = new ConnectionManager({
      configPath: '/tmp/config.json',
      readFile: async (path) => files.get(path) ?? null,
      writeFile: async () => {},
      credentialStore: {
        load: async () => ({ serverUrl: 'http://actual', secretKey: 'secret' }),
        store: async () => {},
      },
      connectorFactory: async () => {
        connectorCreations += 1;
        return connector;
      },
    });

    const first = manager.restore();
    const second = manager.restore();
    releaseConnection?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(connectorCreations).toBe(1);
    expect(firstResult.connector).toBe(secondResult.connector);
  });

  it('rebuilds and disconnects a cached connection when credentials rotate', async () => {
    const files = new Map([
      [
        '/tmp/credential-config.json',
        JSON.stringify({
          version: 1,
          serverUrl: 'http://actual',
          budgetId: 'budget-1',
          budgetName: 'Test Budget',
          groupId: 'group-1',
        }),
      ],
    ]);
    let credentials = {
      serverUrl: 'http://actual',
      secretKey: 'first-secret',
      budgetPassword: 'first-password',
    };
    const disconnects: Mock[] = [];
    const factory = vi.fn(async () => {
      const disconnect = vi.fn(async () => {});
      disconnects.push(disconnect);
      return { ...fakeConnector(), disconnect };
    });
    const manager = new ConnectionManager({
      configPath: '/tmp/credential-config.json',
      readFile: async (path) => files.get(path) ?? null,
      writeFile: async () => {},
      credentialStore: { load: async () => credentials, store: async () => {} },
      connectorFactory: factory,
    });

    await manager.restore();
    credentials = { ...credentials, secretKey: 'second-secret', budgetPassword: 'second-password' };
    await manager.restore();

    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls[1]?.[0]).toEqual(credentials);
    expect(disconnects[0]).toHaveBeenCalledTimes(1);
  });

  it('quarantines a cached connector when disconnect fails', async () => {
    const config = JSON.stringify({
      version: 1,
      serverUrl: 'http://actual',
      budgetId: 'budget-1',
      budgetName: 'Test Budget',
      groupId: 'group-1',
    });
    let connectorCreations = 0;
    let disconnectAttempts = 0;
    const manager = new ConnectionManager({
      configPath: '/tmp/disconnect-failure.json',
      readFile: async () => config,
      writeFile: async () => {},
      credentialStore: {
        load: async () => ({ serverUrl: 'http://actual', secretKey: 'secret' }),
        store: async () => {},
      },
      connectorFactory: async () => {
        connectorCreations += 1;
        return {
          ...fakeConnector(),
          disconnect: async () => {
            disconnectAttempts += 1;
            if (disconnectAttempts <= 2) throw new Error('shutdown failed');
          },
        };
      },
    });

    await manager.restore();
    await expect(manager.disconnect()).rejects.toThrow('shutdown failed');
    await expect(manager.restore()).rejects.toThrow('shutdown failed');

    expect(connectorCreations).toBe(1);
    await manager.disconnect();
  });

  it('preserves a cached synchronization failure when connector cleanup also fails', async () => {
    const synchronizationError = new Error('synchronization failed');
    const disconnectError = new Error('shutdown failed after synchronization');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let synchronizeAttempts = 0;
    let disconnectAttempts = 0;
    const manager = new ConnectionManager({
      configPath: '/tmp/synchronization-cleanup-failure.json',
      readFile: async () =>
        JSON.stringify({
          version: 1,
          serverUrl: 'http://actual',
          budgetId: 'budget-1',
          budgetName: 'Test Budget',
          groupId: 'group-1',
        }),
      writeFile: async () => {},
      credentialStore: {
        load: async () => ({ serverUrl: 'http://actual', secretKey: 'secret' }),
        store: async () => {},
      },
      connectorFactory: async () => ({
        ...fakeConnector(),
        synchronize: async () => {
          synchronizeAttempts += 1;
          if (synchronizeAttempts === 2) throw synchronizationError;
          return {
            snapshot: { transactions: [], categories: [] },
            health: { state: 'healthy' },
            watermark: {},
          };
        },
        disconnect: async () => {
          disconnectAttempts += 1;
          if (disconnectAttempts === 1) throw disconnectError;
        },
      }),
    });

    try {
      await manager.restore();
      await expect(manager.restore()).rejects.toBe(synchronizationError);
      expect(log).toHaveBeenCalledWith(
        'Failed to clean up Actual connector after synchronization failure:',
        disconnectError,
      );
    } finally {
      await manager.disconnect();
      log.mockRestore();
    }
  });

  it('preserves a new connector failure when connector cleanup also fails', async () => {
    const selectionError = new Error('budget selection failed');
    const disconnectError = new Error('shutdown failed after selection');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let disconnectAttempts = 0;
    const manager = new ConnectionManager({
      configPath: '/tmp/selection-cleanup-failure.json',
      readFile: async () =>
        JSON.stringify({
          version: 1,
          serverUrl: 'http://actual',
          budgetId: 'budget-1',
          budgetName: 'Test Budget',
          groupId: 'group-1',
        }),
      writeFile: async () => {},
      credentialStore: {
        load: async () => ({ serverUrl: 'http://actual', secretKey: 'secret' }),
        store: async () => {},
      },
      connectorFactory: async () => ({
        ...fakeConnector(),
        selectBudget: async () => {
          throw selectionError;
        },
        disconnect: async () => {
          disconnectAttempts += 1;
          if (disconnectAttempts === 1) throw disconnectError;
        },
      }),
    });

    try {
      await expect(manager.restore()).rejects.toBe(selectionError);
      expect(log).toHaveBeenCalledWith(
        'Failed to clean up newly created Actual connector:',
        disconnectError,
      );
    } finally {
      await manager.disconnect();
      log.mockRestore();
    }
  });

  it('preserves a connect failure when connector cleanup also fails', async () => {
    const selectionError = new Error('budget selection failed');
    const disconnectError = new Error('shutdown failed after connect');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let disconnectAttempts = 0;
    const manager = new ConnectionManager({
      configPath: '/tmp/connect-cleanup-failure.json',
      readFile: async () => null,
      writeFile: async () => {},
      credentialStore: {
        load: async () => ({ serverUrl: 'http://actual', secretKey: 'secret' }),
        store: async () => {},
      },
      connectorFactory: async () => ({
        ...fakeConnector(),
        selectBudget: async () => {
          throw selectionError;
        },
        disconnect: async () => {
          disconnectAttempts += 1;
          if (disconnectAttempts === 1) throw disconnectError;
        },
      }),
    });

    try {
      await expect(manager.connect({ budgetId: 'budget-1' })).rejects.toBe(selectionError);
      expect(log).toHaveBeenCalledWith(
        'Failed to clean up newly created Actual connector:',
        disconnectError,
      );
    } finally {
      await manager.disconnect();
      log.mockRestore();
    }
  });

  it('preserves a budget discovery failure when connector cleanup also fails', async () => {
    const discoveryError = new Error('budget discovery failed');
    const disconnectError = new Error('shutdown failed after discovery');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let disconnectAttempts = 0;
    const manager = new ConnectionManager({
      configPath: '/tmp/discovery-cleanup-failure.json',
      readFile: async () => null,
      writeFile: async () => {},
      credentialStore: {
        load: async () => null,
        store: async () => {},
      },
      connectorFactory: async () => ({
        ...fakeConnector(),
        connect: async () => {
          throw discoveryError;
        },
        disconnect: async () => {
          disconnectAttempts += 1;
          if (disconnectAttempts === 1) throw disconnectError;
        },
      }),
    });

    try {
      await expect(
        manager.listBudgets({ serverUrl: 'http://actual', secretKey: 'secret' }),
      ).rejects.toBe(discoveryError);
      expect(log).toHaveBeenCalledWith(
        'Failed to clean up Actual connector after budget discovery failure:',
        disconnectError,
      );
    } finally {
      await manager.disconnect();
      log.mockRestore();
    }
  });

  it('serializes restore callbacks, budget discovery, and connection selection globally', async () => {
    const config = JSON.stringify({
      version: 1,
      serverUrl: 'http://actual',
      budgetId: 'budget-1',
      budgetName: 'Test Budget',
      groupId: 'group-1',
    });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const createManager = (name: string) =>
      new ConnectionManager({
        configPath: `/tmp/${name}.json`,
        readFile: async () => config,
        writeFile: async () => {},
        credentialStore: {
          load: async () => ({ serverUrl: 'http://actual', secretKey: 'secret' }),
          store: async () => {},
        },
        connectorFactory: async () => ({
          ...fakeConnector(),
          connect: async () => {
            events.push(`${name}:connect`);
            return fakeConnector().connect();
          },
          disconnect: async () => {
            events.push(`${name}:disconnect`);
          },
        }),
      });
    const reader = createManager('reader');
    const discovery = createManager('discovery');
    const selection = createManager('selection');

    const reading = reader.withConnection(
      async () => {
        events.push('reader:callback:start');
        await firstGate;
        events.push('reader:callback:end');
      },
      { dispose: true },
    );
    await vi.waitFor(() => expect(events).toContain('reader:callback:start'));
    const discovering = discovery.listBudgets();
    const selecting = selection.connect({ budgetId: 'budget-1' });
    await Promise.resolve();
    expect(events).not.toContain('discovery:connect');
    expect(events).not.toContain('selection:connect');

    releaseFirst?.();
    await Promise.all([reading, discovering, selecting]);

    expect(events.indexOf('reader:callback:end')).toBeLessThan(events.indexOf('discovery:connect'));
    expect(events.indexOf('discovery:disconnect')).toBeLessThan(
      events.indexOf('selection:connect'),
    );
  });

  it('disposes a scoped mutation connection before the next restore', async () => {
    const config = JSON.stringify({
      version: 1,
      serverUrl: 'http://actual',
      budgetId: 'budget-1',
      budgetName: 'Test Budget',
      groupId: 'group-1',
    });
    const disconnects: Mock[] = [];
    const factory = vi.fn(async () => {
      const disconnect = vi.fn(async () => {});
      disconnects.push(disconnect);
      return { ...fakeConnector(), disconnect };
    });
    const manager = new ConnectionManager({
      configPath: '/tmp/mutation-config.json',
      readFile: async () => config,
      writeFile: async () => {},
      credentialStore: {
        load: async () => ({ serverUrl: 'http://actual', secretKey: 'secret' }),
        store: async () => {},
      },
      connectorFactory: factory,
    });

    await manager.withConnection(async () => ({ success: false, code: 'SYNC_FAILED' }), {
      dispose: true,
    });
    await manager.restore();

    expect(disconnects[0]).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('fails closed across managers until a failed scoped disposal succeeds on retry', async () => {
    const disconnectError = new Error('shutdown failed after commit');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let disconnectAttempts = 0;
    const first = managerWithDisconnect(async (connectorNumber) => {
      if (connectorNumber === 1 && disconnectAttempts++ < 2) throw disconnectError;
    });
    const second = managerWithDisconnect(async () => {});

    try {
      await expect(
        first.manager.withConnection(async () => 'committed', { dispose: true }),
      ).resolves.toBe('committed');
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        'Failed to dispose scoped Actual connection after operation:',
        disconnectError,
      );

      await expect(second.manager.restore()).rejects.toBe(disconnectError);
      expect(first.connectorFactory).toHaveBeenCalledTimes(1);
      expect(second.connectorFactory).not.toHaveBeenCalled();

      await expect(second.manager.restore()).resolves.toMatchObject({
        budget: { id: 'budget-1' },
      });
      expect(second.connectorFactory).toHaveBeenCalledTimes(1);
    } finally {
      await second.manager.disconnect();
      log.mockRestore();
    }
  });

  it('preserves the callback failure when scoped disposal also fails', async () => {
    const operationError = new Error('mutation failed');
    const disconnectError = new Error('shutdown failed after mutation');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let disconnectAttempts = 0;
    const { manager } = managerWithDisconnect(async () => {
      if (disconnectAttempts++ === 0) throw disconnectError;
    });

    try {
      await expect(
        manager.withConnection(
          async () => {
            throw operationError;
          },
          { dispose: true },
        ),
      ).rejects.toBe(operationError);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        'Failed to dispose scoped Actual connection after operation:',
        disconnectError,
      );
    } finally {
      await manager.disconnect();
      log.mockRestore();
    }
  });

  it('disconnects the temporary connector used for budget discovery', async () => {
    const disconnect = vi.fn(async () => {});
    const manager = new ConnectionManager({
      configPath: '/tmp/discovery-config.json',
      readFile: async () => null,
      writeFile: async () => {},
      credentialStore: {
        load: async () => ({ serverUrl: 'http://actual', secretKey: 'secret' }),
        store: async () => {},
      },
      connectorFactory: async () => ({ ...fakeConnector(), disconnect }),
    });

    await manager.listBudgets();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('shares the production manager for the same config path', () => {
    const first = createDefaultConnectionManager({ configPath: '/tmp/shared-manager-config.json' });
    const second = createDefaultConnectionManager({
      configPath: '/tmp/shared-manager-config.json',
    });

    expect(first).toBe(second);
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

    await expect(manager.restore()).rejects.toMatchObject({
      name: 'ApplicationError',
      code: 'not_connected',
      message: 'No BalanceFrame connection configured. Run connect first.',
      reasonCodes: ['missing_ledger_config'],
      retryable: true,
    });
  });
});

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
});

import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/index';

describe('lifecycle command parsing', () => {
  it('keeps lifecycle operations explicit server commands', () => {
    const cases: Array<{ args: string[]; command: string }> = [
      { args: ['export', '--json'], command: 'export' },
      { args: ['disconnect'], command: 'disconnect' },
      { args: ['remove-connection'], command: 'remove-connection' },
    ];

    for (const item of cases) {
      const result = parseArgs(item.args);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.cmd.command).toBe(item.command);
    }
  });

  it('requires a supported custody scope for delete-data', () => {
    for (const scope of ['connection', 'space', 'user', 'provider', 'workflow', 'notification']) {
      const result = parseArgs(['delete-data', '--scope', scope, '--json']);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.cmd.options?.scope).toBe(scope);
    }

    expect(parseArgs(['delete-data', '--json'])).toMatchObject({ ok: false, error: { code: 'missing_scope' } });
    expect(parseArgs(['delete-data', '--scope', 'everything', '--json'])).toMatchObject({
      ok: false,
      error: { code: 'invalid_scope' },
    });
  });

  it('does not accept caller actor identity as authority for custody operations', () => {
    for (const command of ['export', 'disconnect', 'remove-connection', 'delete-data']) {
      const args = command === 'delete-data' ? [command, '--scope', 'connection'] : [command];
      expect(parseArgs([...args, '--actor-id', 'usr_impostor']).ok).toBe(false);
    }
  });
});

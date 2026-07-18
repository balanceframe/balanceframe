import { describe, it, expect } from 'vitest';
import { parseArgs, CliCommand } from '../src/index';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses transactions pending-review --json', () => {
    const cmd: CliCommand = parseArgs(['transactions', 'pending-review', '--json']);
    expect(cmd.command).toBe('transactions.pending-review');
    expect(cmd.format).toBe('json');
    expect(cmd.args).toEqual(['transactions', 'pending-review', '--json']);
  });

  it('parses reviews show REVIEW_ID --json', () => {
    const cmd: CliCommand = parseArgs(['reviews', 'show', 'rev_abc123', '--json']);
    expect(cmd.command).toBe('reviews.show');
    expect(cmd.reviewId).toBe('rev_abc123');
    expect(cmd.format).toBe('json');
  });

  it('parses budget summary --json', () => {
    const cmd: CliCommand = parseArgs(['budget', 'summary', '--json']);
    expect(cmd.command).toBe('budget.summary');
    expect(cmd.format).toBe('json');
  });

  it('parses export --json', () => {
    const cmd: CliCommand = parseArgs(['export', '--json']);
    expect(cmd.command).toBe('export');
    expect(cmd.format).toBe('json');
  });

  it('parses disconnect', () => {
    const cmd: CliCommand = parseArgs(['disconnect']);
    expect(cmd.command).toBe('disconnect');
  });

  it('parses remove-connection', () => {
    const cmd: CliCommand = parseArgs(['remove-connection']);
    expect(cmd.command).toBe('remove-connection');
  });
});

// ---------------------------------------------------------------------------
// CLI rejects dangerous commands
// ---------------------------------------------------------------------------

describe('parseArgs — rejection', () => {
  it('rejects raw-query', () => {
    expect(() => parseArgs(['raw-query', 'SELECT * FROM transactions'])).toThrow();
  });

  it('rejects invoke-method', () => {
    expect(() => parseArgs(['invoke-method', 'createTransaction'])).toThrow();
  });

  it('rejects shell', () => {
    expect(() => parseArgs(['shell'])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// CLI output format
// ---------------------------------------------------------------------------

describe('CliCommand — output semantics', () => {
  it('defaults format to json when --json is present', () => {
    const cmd = parseArgs(['transactions', 'pending-review', '--json']);
    expect(cmd.format).toBe('json');
  });

  it('provides reviewId for reviews show', () => {
    const cmd = parseArgs(['reviews', 'show', 'rev_xyz', '--json']);
    expect(cmd.reviewId).toBe('rev_xyz');
  });

  it('reviewId is undefined for non-review commands', () => {
    const cmd = parseArgs(['budget', 'summary', '--json']);
    expect(cmd.reviewId).toBeUndefined();
  });
});

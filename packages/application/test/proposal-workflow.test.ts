/**
 * Failing tests for proposal workflow commands and analysis handlers.
 *
 * TDD: failing tests establish the contract before implementation.
 *
 * Categories:
 * - Proposal command routing
 * - Write rejection in Observe mode for proposal commands
 * - Guard checks (no ledger, stale freshness, missing protocol)
 * - Error cases: proposal not found, superseded proposal, expired approval
 * - Authorization failure responses
 */

import { describe, it, expect, vi } from 'vitest';
import { routeCommand, type CommandInput } from '../src/commands';
import { ReasonCodes } from '../src/errors';

// ---------------------------------------------------------------------------
// Route parsing for proposal commands
// ---------------------------------------------------------------------------

describe('routeCommand — proposal commands', () => {
  it('routes proposals create command', () => {
    const input: CommandInput = {
      args: ['proposals', 'create', '--category-id', 'cat-food', '--transaction-id', 'txn-001'],
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      requestId: 'req_001',
      ledger: {},
      freshness: null,
    };
    const result = routeCommand(input);
    expect(result.command).toBe('proposals.create');
    expect(result.route).toBe('analysis');
  });

  it('routes proposals show command', () => {
    const input: CommandInput = {
      args: ['proposals', 'show', 'prop_abc123'],
      mode: 'observe',
      actorId: 'usr_test',
      requestId: 'req_002',
      ledger: {},
      freshness: null,
    };
    const result = routeCommand(input);
    expect(result.command).toBe('proposals.show');
    expect(result.route).toBe('analysis');
  });

  it('routes proposals approve command', () => {
    const input: CommandInput = {
      args: ['proposals', 'approve', 'prop_abc123'],
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      requestId: 'req_003',
      ledger: {},
      freshness: null,
    };
    const result = routeCommand(input);
    expect(result.command).toBe('proposals.approve');
    expect(result.route).toBe('analysis');
  });

  it('routes proposals execute command', () => {
    const input: CommandInput = {
      args: ['proposals', 'execute', 'prop_abc123'],
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      requestId: 'req_004',
      ledger: {},
      freshness: null,
    };
    const result = routeCommand(input);
    expect(result.command).toBe('proposals.execute');
    expect(result.route).toBe('analysis');
  });

  it('routes proposals list command', () => {
    const input: CommandInput = {
      args: ['proposals', 'list'],
      mode: 'observe',
      actorId: 'usr_test',
      requestId: 'req_005',
      ledger: {},
      freshness: null,
    };
    const result = routeCommand(input);
    expect(result.command).toBe('proposals.list');
    expect(result.route).toBe('analysis');
  });

  it('routes audit query command', () => {
    const input: CommandInput = {
      args: ['audit', 'query'],
      mode: 'observe',
      actorId: 'usr_test',
      requestId: 'req_006',
      ledger: {},
      freshness: null,
    };
    const result = routeCommand(input);
    expect(result.command).toBe('audit.query');
    expect(result.route).toBe('analysis');
  });
});

// ---------------------------------------------------------------------------
// Write rejection in Observe mode
// ---------------------------------------------------------------------------

describe('routeCommand — proposal write rejection in Observe mode', () => {
  it('rejects proposals create in observe mode', () => {
    const input: CommandInput = {
      args: ['proposals', 'create', '--category-id', 'cat-food'],
      mode: 'observe',
      actorId: 'usr_test',
      requestId: 'req_write',
      ledger: {},
      freshness: null,
    };
    expect(() => routeCommand(input)).toThrow();
    try {
      routeCommand(input);
    } catch (e) {
      const err = e as { code: string; reasonCodes: string[] };
      expect(err.code).toBe('write_rejected');
      expect(err.reasonCodes).toContain('observe_mode_write_blocked');
    }
  });

  it('rejects proposals approve in observe mode', () => {
    const input: CommandInput = {
      args: ['proposals', 'approve', 'prop_abc'],
      mode: 'observe',
      actorId: 'usr_test',
      requestId: 'req_write',
      ledger: {},
      freshness: null,
    };
    expect(() => routeCommand(input)).toThrow();
  });

  it('rejects proposals execute in observe mode', () => {
    const input: CommandInput = {
      args: ['proposals', 'execute', 'prop_abc'],
      mode: 'observe',
      actorId: 'usr_test',
      requestId: 'req_write',
      ledger: {},
      freshness: null,
    };
    expect(() => routeCommand(input)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Unknown command rejection
// ---------------------------------------------------------------------------

describe('routeCommand — unknown proposal commands', () => {
  it('rejects proposals delete as unknown', () => {
    const input: CommandInput = {
      args: ['proposals', 'delete', 'prop_abc'],
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      requestId: 'req_reject',
      ledger: {},
      freshness: null,
    };
    expect(() => routeCommand(input)).toThrow();
    try {
      routeCommand(input);
    } catch (e) {
      const err = e as { code: string };
      expect(err.code).toBe('unknown_command');
    }
  });
});

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

describe('ReasonCodes — proposal reasons', () => {
  it('defines all proposal-related reason codes', () => {
    expect(ReasonCodes.PROPOSAL_NOT_FOUND).toBe('proposal_not_found');
    expect(ReasonCodes.PROPOSAL_SUPERSEDED).toBe('proposal_superseded');
    expect(ReasonCodes.APPROVAL_EXPIRED).toBe('approval_expired');
    expect(ReasonCodes.APPROVAL_CONSUMED).toBe('approval_consumed');
    expect(ReasonCodes.APPROVAL_SUPERSEDED).toBe('approval_superseded');
    expect(ReasonCodes.PAYLOAD_HASH_MISMATCH).toBe('payload_hash_mismatch');
    expect(ReasonCodes.IDEMPOTENCY_REPLAY_MISMATCH).toBe('idempotency_replay_mismatch');
    expect(ReasonCodes.MEMBER_INACTIVE).toBe('member_inactive');
    expect(ReasonCodes.INSUFFICIENT_CAPABILITY).toBe('insufficient_capability');
    expect(ReasonCodes.INSUFFICIENT_SCOPE).toBe('insufficient_scope');
    expect(ReasonCodes.PROPOSAL_STALE).toBe('proposal_stale');
    expect(ReasonCodes.APPROVAL_NOT_FOUND).toBe('approval_not_found');
  });
});

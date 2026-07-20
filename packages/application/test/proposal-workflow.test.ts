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

// ---------------------------------------------------------------------------
// Proposal analysis — mutation capability success envelopes
// ---------------------------------------------------------------------------

import {
  proposalCreateAnalysis,
  proposalApproveAnalysis,
  proposalExecuteAnalysis,
} from '../src/analysis';
import { ApplicationError } from '../src/errors';
import { AuthorizationContext, type ResponseEnvelope } from '../src/envelope';
import type {
  AnalysisProtocol,
  ProposalCreateResult,
  ProposalActionResult,
  ReviewActionOptions,
} from '../src/commands';

function mockProposalProtocol(): {
  protocol: AnalysisProtocol;
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {
    proposalCreate: [],
    proposalApprove: [],
    proposalExecute: [],
  };

  const protocol: AnalysisProtocol = {
    async proposalCreate(ledger, options) {
      calls.proposalCreate.push({ ledger, options });
      return {
        proposalId: 'prop_new',
        status: 'pending_approval',
        createdAt: '2026-07-20T00:00:00Z',
        summary: 'Categorize txn-001 as Food & Dining',
      } satisfies ProposalCreateResult;
    },
    async proposalApprove(ledger, proposalId, options) {
      calls.proposalApprove.push({ ledger, proposalId, options });
      return {
        proposalId,
        action: 'approved',
        fromStatus: 'pending_approval',
        toStatus: 'approved',
        timestamp: '2026-07-20T00:01:00Z',
        actorId: 'usr_test',
      } satisfies ProposalActionResult;
    },
    async proposalExecute(ledger, proposalId, options) {
      calls.proposalExecute.push({ ledger, proposalId, options });
      return {
        proposalId,
        action: 'executed',
        fromStatus: 'approved',
        toStatus: 'completed',
        timestamp: '2026-07-20T00:02:00Z',
        actorId: 'usr_test',
      } satisfies ProposalActionResult;
    },
  };

  return { protocol, calls };
}

function baseProposalInput(overrides: Partial<CommandInput> = {}): CommandInput {
  return {
    args: [],
    mode: 'reviewAndApply',
    actorId: 'usr_test',
    requestId: 'req_prop',
    ledger: { mockLedger: true },
    freshness: null,
    ...overrides,
  };
}

function throwingProtocol(): AnalysisProtocol {
  return {
    async proposalCreate() { throw new Error('Provider unreachable'); },
    async proposalApprove() { throw new Error('Provider unreachable'); },
    async proposalExecute() { throw new Error('Provider unreachable'); },
  };
}

// ---------------------------------------------------------------------------
// proposalCreateAnalysis
// ---------------------------------------------------------------------------

describe('proposalCreateAnalysis', () => {
  it('returns success envelope with mutation capability', async () => {
    const { protocol, calls } = mockProposalProtocol();
    const input = baseProposalInput({ analysisProtocol: protocol });
    const envelope = await proposalCreateAnalysis(input);

    expect(calls.proposalCreate).toHaveLength(1);
    expect(calls.proposalCreate[0]).toMatchObject({ ledger: input.ledger });
    expect(envelope.status).toBe('ok');
    expect(envelope.result).toBeTruthy();
    expect(envelope.result!.proposalId).toBe('prop_new');
    expect(envelope.result!.status).toBe('pending_approval');
    expect(envelope.authorization).toBeTruthy();
    expect(envelope.authorization!.actorId).toBe('usr_test');
    expect(envelope.authorization!.capability).toBe('proposal.create');
    expect(envelope.authorization!.allowed).toBe(true);
  });

  it('returns error envelope when protocol throws', async () => {
    const protocol = throwingProtocol();
    const input = baseProposalInput({ analysisProtocol: protocol });
    const envelope = await proposalCreateAnalysis(input);

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('analysis_failed');
    expect(envelope.error!.message).toContain('Provider unreachable');
    expect(envelope.error!.retryable).toBe(false);
    expect(envelope.error!.reasonCodes).toEqual(['analysis_error']);
  });

  it('preserves ApplicationError code and retryability', async () => {
    const protocol: AnalysisProtocol = {
      async proposalCreate() {
        throw new ApplicationError({
          code: 'proposal_not_found',
          message: 'Proposal prop_missing was not found.',
          reasonCodes: ['proposal_not_found'],
          retryable: false,
        });
      },
    };
    const input = baseProposalInput({ analysisProtocol: protocol });
    const envelope = await proposalCreateAnalysis(input);

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('proposal_not_found');
    expect(envelope.error!.retryable).toBe(false);
    expect(envelope.error!.reasonCodes).toContain('proposal_not_found');
  });
});

// ---------------------------------------------------------------------------
// proposalApproveAnalysis
// ---------------------------------------------------------------------------

describe('proposalApproveAnalysis', () => {
  it('returns success envelope with mutation capability', async () => {
    const { protocol, calls } = mockProposalProtocol();
    const input = baseProposalInput({ analysisProtocol: protocol });
    const envelope = await proposalApproveAnalysis(input, 'prop_abc');

    expect(calls.proposalApprove).toHaveLength(1);
    expect(calls.proposalApprove[0]).toMatchObject({ ledger: input.ledger, proposalId: 'prop_abc' });
    expect(envelope.status).toBe('ok');
    expect(envelope.result!.proposalId).toBe('prop_abc');
    expect(envelope.result!.action).toBe('approved');
    expect(envelope.authorization).toBeTruthy();
    expect(envelope.authorization!.actorId).toBe('usr_test');
    expect(envelope.authorization!.capability).toBe('proposal.approve');
    expect(envelope.authorization!.allowed).toBe(true);
  });

  it('preserves proposal_not_found from protocol', async () => {
    const protocol: AnalysisProtocol = {
      async proposalApprove() {
        throw new ApplicationError({
          code: 'proposal_not_found',
          message: 'Proposal prop_missing was not found.',
          reasonCodes: ['proposal_not_found'],
          retryable: false,
        });
      },
    };
    const input = baseProposalInput({ analysisProtocol: protocol });
    const envelope = await proposalApproveAnalysis(input, 'prop_missing');

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('proposal_not_found');
    expect(envelope.error!.retryable).toBe(false);
    expect(envelope.error!.reasonCodes).toEqual(['proposal_not_found']);
  });

  it('preserves approval_expired from protocol', async () => {
    const protocol: AnalysisProtocol = {
      async proposalApprove() {
        throw new ApplicationError({
          code: 'approval_expired',
          message: 'Approval for proposal prop_abc has expired.',
          reasonCodes: ['approval_expired'],
          retryable: false,
        });
      },
    };
    const input = baseProposalInput({ analysisProtocol: protocol });
    const envelope = await proposalApproveAnalysis(input, 'prop_abc');

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('approval_expired');
    expect(envelope.error!.retryable).toBe(false);
    expect(envelope.error!.reasonCodes).toContain('approval_expired');
  });

  it('preserves approval_consumed from protocol', async () => {
    const protocol: AnalysisProtocol = {
      async proposalApprove() {
        throw new ApplicationError({
          code: 'approval_consumed',
          message: 'Approval for proposal prop_abc has already been consumed.',
          reasonCodes: ['approval_consumed'],
          retryable: false,
        });
      },
    };
    const input = baseProposalInput({ analysisProtocol: protocol });
    const envelope = await proposalApproveAnalysis(input, 'prop_abc');

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('approval_consumed');
    expect(envelope.error!.retryable).toBe(false);
    expect(envelope.error!.reasonCodes).toContain('approval_consumed');
  });

  it('preserves payload_hash_mismatch from protocol', async () => {
    const protocol: AnalysisProtocol = {
      async proposalApprove() {
        throw new ApplicationError({
          code: 'payload_mismatch',
          message: 'Payload hash does not match expected value for proposal prop_abc.',
          reasonCodes: ['payload_hash_mismatch'],
          retryable: false,
        });
      },
    };
    const input = baseProposalInput({ analysisProtocol: protocol });
    const envelope = await proposalApproveAnalysis(input, 'prop_abc');

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('payload_mismatch');
    expect(envelope.error!.retryable).toBe(false);
    expect(envelope.error!.reasonCodes).toContain('payload_hash_mismatch');
  });

  it('preserves authorization failure from protocol', async () => {
    const protocol: AnalysisProtocol = {
      async proposalApprove() {
        throw new ApplicationError({
          code: 'authorization_failed',
          message: 'Member usr_test lacks capability proposal.approve.',
          reasonCodes: ['insufficient_capability'],
          retryable: false,
        });
      },
    };
    const input = baseProposalInput({ analysisProtocol: protocol });
    const envelope = await proposalApproveAnalysis(input, 'prop_abc');

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('authorization_failed');
    expect(envelope.error!.retryable).toBe(false);
    expect(envelope.error!.reasonCodes).toContain('insufficient_capability');
  });

  it('returns error envelope when protocol throws', async () => {
    const protocol = throwingProtocol();
    const input = baseProposalInput({ analysisProtocol: protocol });
    const envelope = await proposalApproveAnalysis(input, 'prop_abc');

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('analysis_failed');
    expect(envelope.error!.message).toContain('Provider unreachable');
    expect(envelope.error!.retryable).toBe(false);
    expect(envelope.error!.reasonCodes).toEqual(['analysis_error']);
  });
});

// ---------------------------------------------------------------------------
// proposalExecuteAnalysis
// ---------------------------------------------------------------------------

describe('proposalExecuteAnalysis', () => {
  it('returns success envelope with mutation capability', async () => {
    const { protocol, calls } = mockProposalProtocol();
    const input = baseProposalInput({ analysisProtocol: protocol });
    const envelope = await proposalExecuteAnalysis(input, 'prop_abc');

    expect(calls.proposalExecute).toHaveLength(1);
    expect(calls.proposalExecute[0]).toMatchObject({ ledger: input.ledger, proposalId: 'prop_abc' });
    expect(envelope.status).toBe('ok');
    expect(envelope.result!.proposalId).toBe('prop_abc');
    expect(envelope.result!.action).toBe('executed');
    expect(envelope.authorization).toBeTruthy();
    expect(envelope.authorization!.actorId).toBe('usr_test');
    expect(envelope.authorization!.capability).toBe('proposal.execute');
    expect(envelope.authorization!.allowed).toBe(true);
  });

  it('preserves approval_expired from protocol', async () => {
    const protocol: AnalysisProtocol = {
      async proposalExecute() {
        throw new ApplicationError({
          code: 'approval_expired',
          message: 'Approval for proposal prop_abc has expired.',
          reasonCodes: ['approval_expired'],
          retryable: false,
        });
      },
    };
    const input = baseProposalInput({ analysisProtocol: protocol });
    const envelope = await proposalExecuteAnalysis(input, 'prop_abc');

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('approval_expired');
    expect(envelope.error!.retryable).toBe(false);
    expect(envelope.error!.reasonCodes).toContain('approval_expired');
  });

  it('preserves payload_hash_mismatch from protocol', async () => {
    const protocol: AnalysisProtocol = {
      async proposalExecute() {
        throw new ApplicationError({
          code: 'payload_mismatch',
          message: 'Payload hash mismatch for proposal prop_abc.',
          reasonCodes: ['payload_hash_mismatch'],
          retryable: false,
        });
      },
    };
    const input = baseProposalInput({ analysisProtocol: protocol });
    const envelope = await proposalExecuteAnalysis(input, 'prop_abc');

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('payload_mismatch');
    expect(envelope.error!.retryable).toBe(false);
    expect(envelope.error!.reasonCodes).toContain('payload_hash_mismatch');
  });

  it('preserves authorization failure from protocol', async () => {
    const protocol: AnalysisProtocol = {
      async proposalExecute() {
        throw new ApplicationError({
          code: 'authorization_failed',
          message: 'Member usr_test is not active.',
          reasonCodes: ['member_inactive', 'insufficient_capability'],
          retryable: false,
        });
      },
    };
    const input = baseProposalInput({ analysisProtocol: protocol });
    const envelope = await proposalExecuteAnalysis(input, 'prop_abc');

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('authorization_failed');
    expect(envelope.error!.retryable).toBe(false);
    expect(envelope.error!.reasonCodes).toContain('member_inactive');
    expect(envelope.error!.reasonCodes).toContain('insufficient_capability');
  });

  it('returns error envelope when protocol throws', async () => {
    const protocol = throwingProtocol();
    const input = baseProposalInput({ analysisProtocol: protocol });
    const envelope = await proposalExecuteAnalysis(input, 'prop_abc');

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('analysis_failed');
    expect(envelope.error!.message).toContain('Provider unreachable');
    expect(envelope.error!.retryable).toBe(false);
    expect(envelope.error!.reasonCodes).toEqual(['analysis_error']);
  });
});

// ---------------------------------------------------------------------------
// Guard failure tests shared across proposal handlers
// ---------------------------------------------------------------------------

describe('proposal analysis — guard failures', () => {
  const cases: Array<{
    name: string;
    call: (input: CommandInput) => Promise<ResponseEnvelope>;
  }> = [
    { name: 'create', call: (i) => proposalCreateAnalysis(i) },
    { name: 'approve', call: (i) => proposalApproveAnalysis(i, 'prop_abc') },
    { name: 'execute', call: (i) => proposalExecuteAnalysis(i, 'prop_abc') },
  ];

  for (const { name, call } of cases) {
    it(`'${name}' returns not_connected when ledger is null`, async () => {
      const input = baseProposalInput({ ledger: null });
      const envelope = await call(input);
      expect(envelope.status).toBe('error');
      expect(envelope.error!.code).toBe('not_connected');
    });

    it(`'${name}' returns proposal_stale when freshness is stale`, async () => {
      const input = baseProposalInput({
        freshness: {
          actualDownloadedAt: '2026-06-01T00:00:00Z',
          bankSyncedAt: null,
          pendingTransactionsIncluded: false,
          stalenessDays: 30,
          isStale: true,
        },
      });
      const envelope = await call(input);
      expect(envelope.status).toBe('error');
      expect(envelope.error!.code).toBe('proposal_stale');
      expect(envelope.error!.reasonCodes).toContain('proposal_stale');
    });

    it(`'${name}' returns no_analysis_protocol when analysisProtocol is missing`, async () => {
      const input = baseProposalInput({ analysisProtocol: undefined });
      const envelope = await call(input);
      expect(envelope.status).toBe('error');
      expect(envelope.error!.code).toBe('no_analysis_protocol');
    });
  }
});

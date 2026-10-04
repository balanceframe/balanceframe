import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';

interface NativeRuleBindings {
  planCreateRule(input: string): string;
  simulateCreateRulePlan(input: string): string;
  verifyRuleMutation(input: string): string;
}


const native = createRequire(import.meta.url)('@balanceframe/native') as NativeRuleBindings;
const createRulePlanSchema = z.object({
  planId: z.string().min(1),
  ruleName: z.string(),
  trigger: z.object({ type: z.string(), value: z.string() }),
  actions: z.array(z.object({ type: z.string(), value: z.string() })),
  hash: z.string().min(1),
  conditions: z.array(
    z.object({ field: z.string(), operation: z.string(), value: z.string() }),
  ),
});
const verificationSchema = z.object({
  verified: z.boolean(),
  reasonCodes: z.array(z.string()),
  message: z.string().nullable(),
});
const ruleSimulationSchema = z.object({
  ruleId: z.string(),
  name: z.string(),
  transactionsMatched: z.number().int().nonnegative(),
  transactionsAffected: z.array(z.string()),
  categoryDistribution: z.record(z.number().int().nonnegative()),
  conflicts: z.array(z.string()),
  examples: z.array(
    z.object({
      txId: z.string(),
      payee: z.string().nullable(),
      amount: z.object({ minorUnits: z.string(), currency: z.string() }),
      currentCategory: z.string().nullable(),
      wouldChange: z.boolean(),
    }),
  ),
});

const baseSnapshot = canonicalProtocolSnapshotSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('../../../protocol/fixtures/representative.json', import.meta.url),
      'utf8',
    ),
  ),
);

function verifyRuleMutation(plan: unknown, snapshot: ProtocolSnapshot) {
  return verificationSchema.parse(
    JSON.parse(native.verifyRuleMutation(JSON.stringify({ plan, snapshot }))),
  );
}

describe('compiled native rule mutation contract', () => {
  it('plans, simulates, and verifies a matching wrapped Actual rule with the compiled native API', () => {
    const plan = createRulePlanSchema.parse(
      JSON.parse(
        native.planCreateRule(
          JSON.stringify({
            ruleName: 'Whole Foods categorization',
            payeeName: 'Whole Foods',
            categoryId: 'cat_2',
            snapshot: baseSnapshot,
          }),
        ),
      ),
    );

    expect(plan).toMatchObject({
      ruleName: 'Whole Foods categorization',
      trigger: { type: 'payee_is', value: 'whole foods' },
      actions: [{ type: 'set_category', value: 'cat_2' }],
      conditions: [{ field: 'payee', operation: 'is', value: 'Whole Foods' }],
    });
    expect(plan).not.toHaveProperty('preconditions');
    expect(plan).not.toHaveProperty('expectedOutcome');

    const simulation = ruleSimulationSchema.parse(
      JSON.parse(native.simulateCreateRulePlan(JSON.stringify({ plan, snapshot: baseSnapshot }))),
    );
    expect(simulation.transactionsMatched).toBeGreaterThan(0);
    expect(simulation.transactionsAffected).toContain('tx_000');
    expect(simulation.conflicts).toEqual([]);
    expect(simulation.categoryDistribution.cat_2).toBeGreaterThan(0);

    const absent = verifyRuleMutation(plan, baseSnapshot);
    expect(absent.verified).toBe(false);

    const matchingRule = {
      id: 'rule_created_native',
      name: 'Whole Foods',
      order: 0,
      trigger: {
        stage: 'post',
        conditionsOp: 'and',
        conditions: [{ field: 'payee_name', op: 'is', value: 'Whole Foods' }],
      },
      actions: [{ op: 'set', field: 'category', value: 'cat_2' }],
      inactive: false,
    };
    const afterWrite: ProtocolSnapshot = {
      ...baseSnapshot,
      rules: [matchingRule],
    };

    expect(verifyRuleMutation(plan, afterWrite).verified).toBe(true);
    expect(
      verifyRuleMutation(plan, {
        ...afterWrite,
        rules: [
          {
            ...matchingRule,
            trigger: {
              ...matchingRule.trigger,
              conditionsOp: 'or',
            },
          },
        ],
      }).verified,
    ).toBe(false);
  });
});

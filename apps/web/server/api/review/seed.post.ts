/**
 * POST /api/review/seed — seed test review items for local development.
 *
 * Creates several `pending_review` items with varied categories, merchants,
 * and evidence so the Edit/correct modal can be exercised without a real
 * Actual Budget connection.
 *
 * This endpoint is available only when BALANCEFRAME_SEED_ALLOWED=true
 * (default false in production).
 */

import { defineEventHandler, setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  getActorId,
  okEnvelope,
  errorEnvelope,
  buildAuthorizationInfo,
} from '../../utils/workflow-store';

interface SeedTemplate {
  transactionId: string;
  merchant: string;
  categoryId: string;
  alternatives: string[];
  originalName?: string;
}


/** Human-friendly names for seed category IDs. */
const CATEGORY_NAMES: Record<string, string> = {
  ID_GROCERIES: 'Groceries',
  ID_FOOD_DINING: 'Food & Dining',
  ID_HOUSEHOLD: 'Household',
  ID_UTILITIES: 'Utilities',
  ID_HOUSING: 'Housing',
  ID_TRANSPORTATION: 'Transportation',
  ID_AUTO_MAINTENANCE: 'Auto Maintenance',
  ID_TRAVEL: 'Travel',
  ID_SHOPPING: 'Shopping',
  ID_ELECTRONICS: 'Electronics',
  ID_ENTERTAINMENT: 'Entertainment',
  ID_SUBSCRIPTIONS: 'Subscriptions',
  ID_STREAMING: 'Streaming',
};
const SEED_DATA: SeedTemplate[] = [
  {
    transactionId: 'seed-grocery-001',
    merchant: 'Whole Foods',
    categoryId: 'ID_GROCERIES',
    alternatives: ['ID_FOOD_DINING', 'ID_HOUSEHOLD'],
  },
  {
    transactionId: 'seed-utility-002',
    merchant: 'PG&E',
    originalName: 'PG&E BILL PAYMENT THANK YOU',
    categoryId: 'ID_UTILITIES',
    alternatives: ['ID_HOUSING', 'ID_HOUSEHOLD'],
  },
  {
    transactionId: 'seed-dining-003',
    merchant: 'Uber Eats',
    originalName: 'Uber Eats *RESTAURANT',
    categoryId: 'ID_FOOD_DINING',
    alternatives: ['ID_GROCERIES', 'ID_ENTERTAINMENT'],
  },
  {
    transactionId: 'seed-transport-004',
    merchant: 'Shell Gas',
    originalName: 'SHELL OIL 123456',
    categoryId: 'ID_TRANSPORTATION',
    alternatives: ['ID_AUTO_MAINTENANCE', 'ID_TRAVEL'],
  },
  {
    transactionId: 'seed-shopping-005',
    merchant: 'Amazon',
    originalName: 'AMZN MKTP US*',
    categoryId: 'ID_SHOPPING',
    alternatives: ['ID_ENTERTAINMENT', 'ID_HOUSEHOLD', 'ID_ELECTRONICS'],
  },
  {
    transactionId: 'seed-subscription-006',
    merchant: 'Netflix',
    originalName: 'NETFLIX.COM',
    categoryId: 'ID_ENTERTAINMENT',
    alternatives: ['ID_SUBSCRIPTIONS', 'ID_STREAMING'],
  },
];

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();

  // Safety gate — only allowed when explicitly enabled.
  if (process.env.BALANCEFRAME_SEED_ALLOWED !== 'true') {
    setResponseStatus(event, 403);
    return errorEnvelope(
      'SEED_DISABLED',
      'Seed endpoint is disabled. Set BALANCEFRAME_SEED_ALLOWED=true to enable.',
      authInfo,
      false,
      requestId,
    );
  }

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  const store = wf.store;
  const created: { id: string; transactionId: string; merchant: string; categoryId: string }[] = [];

  for (const tpl of SEED_DATA) {
    const evidence: Record<string, unknown> = {
      originalName: tpl.originalName ?? tpl.merchant,
      normalizedMerchant: tpl.merchant,
      account: 'Checking Account',
      amount: -Math.floor(Math.random() * 15000 + 500) / 100,
      currentCategory: tpl.categoryId,
      alternatives: tpl.alternatives,
      categoryNames: CATEGORY_NAMES,
      history: [
        { categoryId: tpl.alternatives[0]!, count: 2, lastClassified: new Date().toISOString() },
        { categoryId: tpl.categoryId, count: 5, lastClassified: new Date().toISOString() },
      ],
    };

    try {
      const item = await store.createReviewItem({
        budgetId: 'seed-budget',
        transactionId: tpl.transactionId,
        categoryId: tpl.categoryId,
        classifier: 'seed-classifier',
        provenance: 'dev-seed',
        evidence,
        priority: -created.length, // reverse order so first seeded is first in queue
        freshnessExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), // 24h
      });

      // Transition through required lifecycle to pending_review
      const sg = await store.transitionReviewItem(item.id, {
        toStatus: 'suggestion_generated',
        actor: 'seed',
        expectedVersion: item.version,
      });
      const pr = await store.transitionReviewItem(sg.id, {
        toStatus: 'pending_review',
        actor: 'seed',
        expectedVersion: sg.version,
      });

      created.push({
        id: pr.id,
        transactionId: tpl.transactionId,
        merchant: tpl.merchant,
        categoryId: tpl.categoryId,
      });
    } catch (e) {
      created.push({
        id: `error: ${e instanceof Error ? e.message : String(e)}`,
        transactionId: tpl.transactionId,
        merchant: tpl.merchant,
        categoryId: tpl.categoryId,
      });
    }
  }

  return okEnvelope({ seeded: created.length, items: created }, authInfo, requestId);
});

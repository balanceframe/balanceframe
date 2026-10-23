import { dirname, join } from 'node:path';
import {
  createDefaultConnectionManager,
  createTransactionEvidenceService,
} from '@balanceframe/application';
import type { WorkflowStore } from '@balanceframe/workflow-store';
import type { H3Event } from 'h3';
import { loadEvidenceEncryptionKey } from './evidence-key';

/** Compose evidence reads and ordinary action captures with the same persistent key. */
export async function createWebTransactionEvidenceService(store: WorkflowStore, event?: H3Event) {
  let runtime: Record<string, unknown> = {};
  if (event) {
    try {
      runtime = useRuntimeConfig(event) as Record<string, unknown>;
    } catch {
      runtime = (event.context.runtimeConfig as Record<string, unknown> | undefined) ?? {};
    }
  }
  const dbPath =
    typeof runtime.workflowDbPath === 'string' && runtime.workflowDbPath
      ? runtime.workflowDbPath
      : process.env.BALANCEFRAME_WORKFLOW_DB_PATH ||
        process.env.NUXT_WORKFLOW_DB_PATH ||
        './data/workflow.db';
  const key = loadEvidenceEncryptionKey(
    process.env.BALANCEFRAME_EVIDENCE_KEY_PATH || join(dirname(dbPath), 'evidence.key'),
  );
  return createTransactionEvidenceService({
    store,
    rawEncryptionKey: key,
    connectionManager: createDefaultConnectionManager({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    }),
  });
}

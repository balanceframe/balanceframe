import { getQuery } from 'h3';
import { z } from 'zod';
import { spaceGovernanceRoute } from '../../../utils/space-governance';
import type { SpaceAuditRecord } from '@balanceframe/workflow-store';

const AuditQuery = z.object({
  actorId: z.string().min(1).max(256).optional(),
  entityId: z.string().min(1).max(256).optional(),
  action: z.string().min(1).max(128).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
}).strict();

function publicEntityId(record: SpaceAuditRecord): string | null {
  if (record.classification === 'budget_bound' ||
    record.classification === 'legacy_budget_backfilled' ||
    record.classification === 'legacy_approval_policy_imported') return null;
  return record.subjectId;
}

/** Lists attributed audit classifications without exposing stored details. */
export default spaceGovernanceRoute({ capability: 'audit:read' }, ({ event, selected, store, now }) => {
  const query = AuditQuery.parse(getQuery(event));
  const filtered = store.governance.listAuditRecords({
    spaceId: selected.space.id,
    actorId: selected.membership.actorId,
    now,
  }).filter((record) =>
    (!query.actorId || record.actorId === query.actorId) &&
    (!query.entityId || publicEntityId(record) === query.entityId) &&
    (!query.action || record.classification === query.action) &&
    (!query.from || record.timestamp >= query.from) &&
    (!query.to || record.timestamp <= query.to));
  return {
    records: filtered.slice(query.offset, query.offset + query.limit).map((record) => ({
      id: record.id,
      actorId: record.actorId,
      action: record.classification,
      entityId: publicEntityId(record),
      timestamp: record.timestamp,
    })),
    total: filtered.length,
    limit: query.limit,
    offset: query.offset,
  };
});

import { readEvidenceBody } from '../../utils/bounded-json';
import { z } from 'zod';
import { evidenceRoute } from '../../utils/transaction-evidence';

const decision = z
  .object({
    resolutionHash: z.string().regex(/^[a-f0-9]{64}$/),
    relationships: z.array(z.unknown()).max(20000),
    purposeDecisions: z.array(z.unknown()).max(10000).optional(),
    ledgerEffects: z.array(z.unknown()).max(10000).optional(),
    itemCategoryDecisions: z
      .array(
        z
          .object({
            receiptId: z.string().trim().min(1).max(256),
            lineId: z.string().trim().min(1).max(256),
            accountId: z.string().trim().min(1).max(256),
            categoryId: z.string().trim().min(1).max(256).nullable(),
          })
          .strict(),
      )
      .max(10000)
      .optional(),
  })
  .strict();
/** Record exact reviewed evidence corrections; the service reruns Rust before persistence. */
export default evidenceRoute(
  async (event, service, actor) =>
    service.saveResolutionDecision(actor, {
      ...decision.parse(await readEvidenceBody(event)),
      policyVersion: actor.governancePolicyVersion,
    }),
  { write: true, human: true, capability: 'resolve' },
);

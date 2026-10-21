import { readEvidenceBody } from '../../utils/bounded-json';
import { z } from 'zod';
import { evidenceRoute } from '../../utils/transaction-evidence';
/** Resolve current normalized evidence in Rust; this does not execute a ledger proposal. */
export default evidenceRoute(
  async (event, service, actor) => {
    z.object({})
      .strict()
      .parse(await readEvidenceBody(event));
    return service.resolve(actor, { policyVersion: actor.governancePolicyVersion });
  },
  { write: true, capability: 'resolve' },
);

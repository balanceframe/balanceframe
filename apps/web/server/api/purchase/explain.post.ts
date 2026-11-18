import { liquidityPurchaseInputSchema } from '@balanceframe/application';
import { setHeader } from 'h3';
import { liquidityRoute } from '../../utils/liquidity-service';
import { readBoundedJsonBody } from '../../utils/bounded-json';
import { createConversationExplanationRuntime } from '../../utils/conversation-explanation';

/** Explain a server-evaluated public Decision Card under current selected-space authority. */
export default liquidityRoute(
  async (event, service, actor) => {
    setHeader(event, 'Cache-Control', 'private, no-store');
    const input = liquidityPurchaseInputSchema.parse(await readBoundedJsonBody(event, 4096));
    return service.explainPurchase(
      actor,
      input,
      createConversationExplanationRuntime(event, actor),
    );
  },
  { capability: 'affordability:evaluate' },
);

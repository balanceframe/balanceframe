import { liquidityPurchaseQuerySchema } from '@balanceframe/application';
import { getQuery } from 'h3';
import { liquidityRoute } from '../../utils/liquidity-service';

/** Existing purchase checks use the same authoritative, scoped account-aware service as transfer planning. */
export default liquidityRoute(async (event, service, actor) => {
  const query = liquidityPurchaseQuerySchema.parse(getQuery(event));
  return service.evaluatePurchase(actor, {
    kind: 'purchase',
    categoryId: query.categoryId,
    amount: { minorUnits: query.amount, currency: query.currency },
    ...(query.accountId ? { accountId: query.accountId } : {}),
    purchaseAt: query.purchaseAt,
    requiredBy: query.requiredBy,
  });
}, true);

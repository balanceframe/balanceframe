import { getQuery } from 'h3';
import { merchantAnalyzeQuery, merchantRoute } from '../../utils/merchant-service';
/** Read currently admitted local merchant evidence. */
export default merchantRoute(async (event, service, actor) => {
  const { transactionId, ...input } = merchantAnalyzeQuery.parse(getQuery(event));
  return service.analyze(actor, { ...input, ...(transactionId ? { transactionIds: [transactionId] } : {}) });
}, { query: true });

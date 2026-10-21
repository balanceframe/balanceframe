import { evidenceRoute } from '../../../utils/transaction-evidence';
/** Read scoped immutable item-rule simulations and approval history. */
export default evidenceRoute(async (_event, service, actor) => service.listItemRules(actor), {
  capability: 'item-rule:read',
});

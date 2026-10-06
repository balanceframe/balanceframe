import { getQuery } from 'h3';
import { merchantCalendarQuery, merchantRoute } from '../../utils/merchant-service';
/** Offline lookup from stored selections; absent or unsupported calendars remain unknown. */
export default merchantRoute(async (event, service, actor) => service.calendar(actor, merchantCalendarQuery.parse(getQuery(event))), { capability: 'policy', query: true });

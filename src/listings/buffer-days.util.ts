import { clampBuffer, MAX_BUFFER_DAYS, type DateRange } from './availability.util';
import { calendarDayNumber, calendarDayToISO } from '../common/calendar-date.util';

type Queryable = { query: (sql: string, params?: any[]) => Promise<any> };

/** Host turnover buffer from listing_pricing.buffer_days; 0 when the table/row is missing or the query fails. */
export async function loadBufferDays(db: Queryable | undefined, listingId: string): Promise<number> {
  if (!db || typeof db.query !== 'function') return 0;
  try {
    const [reg] = (await db.query(`select to_regclass('public.listing_pricing') is not null as ok`)) ?? [];
    if (!reg?.ok) return 0;
    const [row] = (await db.query(`select buffer_days from listing_pricing where listing_id = $1`, [listingId])) ?? [];
    return clampBuffer(row?.buffer_days);
  } catch {
    return 0;
  }
}

/** The stay widened by the max buffer: a superset query window for candidate occupied rows. */
export function widenedWindow(moveIn: string, moveOut: string): DateRange {
  return {
    start: calendarDayToISO(calendarDayNumber(moveIn) - MAX_BUFFER_DAYS),
    end: calendarDayToISO(calendarDayNumber(moveOut) + MAX_BUFFER_DAYS),
  };
}

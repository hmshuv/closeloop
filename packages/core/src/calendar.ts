/** Date helpers for ISO dates ("YYYY-MM-DD"). All arithmetic is done in UTC so there are no DST/TZ surprises. */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export interface BankCalendar {
  /** RBI rule: 2nd and 4th Saturdays of every month are bank holidays. */
  secondAndFourthSaturdayOff: boolean;
  holidays: ReadonlySet<string>;
}

function toUtcMs(date: string): number {
  if (!DATE_RE.test(date)) throw new Error(`Expected YYYY-MM-DD, got "${date}"`);
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`Invalid date "${date}"`);
  return ms;
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** Whole calendar days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday */
export function dayOfWeek(date: string): number {
  return new Date(toUtcMs(date)).getUTCDay();
}

export function dayOfYear(date: string): number {
  return daysBetween(`${date.slice(0, 4)}-01-01`, date) + 1;
}

export function isBusinessDay(date: string, cal: BankCalendar): boolean {
  const dow = dayOfWeek(date);
  if (dow === 0) return false;
  if (dow === 6 && cal.secondAndFourthSaturdayOff) {
    const nth = Math.ceil(Number(date.slice(8, 10)) / 7);
    if (nth === 2 || nth === 4) return false;
  }
  return !cal.holidays.has(date);
}

/** First business day strictly after `date`. */
export function nextBusinessDay(date: string, cal: BankCalendar): string {
  let d = addDays(date, 1);
  while (!isBusinessDay(d, cal)) d = addDays(d, 1);
  return d;
}

/**
 * T+n: the n-th business day strictly after `date`.
 * n = 0 returns `date` itself if it is a business day, otherwise the next business day.
 */
export function addBusinessDays(date: string, n: number, cal: BankCalendar): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`n must be a non-negative integer, got ${n}`);
  if (n === 0) return isBusinessDay(date, cal) ? date : nextBusinessDay(date, cal);
  let d = date;
  for (let i = 0; i < n; i++) d = nextBusinessDay(d, cal);
  return d;
}

/** Number of business days d with from < d ≤ to. Negative when `to` is before `from`. */
export function businessDaysBetween(from: string, to: string, cal: BankCalendar): number {
  if (to < from) return -businessDaysBetween(to, from, cal);
  let count = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) {
    if (isBusinessDay(d, cal)) count++;
  }
  return count;
}

/**
 * Earliest date d such that businessDaysBetween(d, date) ≤ businessDays.
 * Lets callers test "within N business days before `date`" with plain string comparison.
 */
export function windowStart(date: string, businessDays: number, cal: BankCalendar): string {
  let start = date;
  let count = 0;
  for (;;) {
    // Moving the start back one day adds `start` itself to the interval (start − 1, date].
    const next = count + (isBusinessDay(start, cal) ? 1 : 0);
    if (next > businessDays) return start;
    count = next;
    start = addDays(start, -1);
  }
}

/** Inclusive list of calendar dates. */
export function datesInRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

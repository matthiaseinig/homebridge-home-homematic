const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True when `timeZone` is an IANA zone the runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Local calendar day `YYYY-MM-DD` of an epoch millisecond value in `timeZone`. */
export function dayKey(epochMs: number, timeZone: string): string {
  return formatter(timeZone).format(new Date(epochMs));
}

export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const MONTH_PATTERN = /^\d{4}-\d{2}$/;

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** Offset of `timeZone` from UTC at `epochMs`, in ms (positive east of Greenwich). */
export function utcOffsetMs(epochMs: number, timeZone: string): number {
  let f = offsetFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    offsetFormatters.set(timeZone, f);
  }
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const at = (k: string): number => parts[k] ?? 0;
  const wall = Date.UTC(at('year'), at('month') - 1, at('day'), at('hour'), at('minute'), at('second'));
  return wall - Math.floor(epochMs / 1000) * 1000;
}

/** Year, month (1 to 12) and day of a `YYYY-MM-DD` key (0 for a missing part). */
export function ymd(day: string): [number, number, number] {
  const [y = 0, m = 0, d = 0] = day.split('-').map(Number);
  return [y, m, d];
}

/** Epoch ms of local midnight that starts `day` (`YYYY-MM-DD`) in `timeZone`. */
export function dayStartMs(day: string, timeZone: string): number {
  const [y, m, d] = ymd(day);
  const wall = Date.UTC(y, m - 1, d);
  let guess = wall - utcOffsetMs(wall, timeZone);
  guess = wall - utcOffsetMs(guess, timeZone);
  return guess;
}

/** `YYYY-MM-DD` shifted by `delta` calendar days. */
export function addDays(day: string, delta: number): string {
  const [y, m, d] = ymd(day);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

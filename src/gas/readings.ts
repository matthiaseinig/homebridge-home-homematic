import { addDays, dayKey, utcOffsetMs, ymd } from './dates.js';
import type { MeterReading } from './config.js';
import { roundM3 } from './factors.js';

/** What the readings need from the gas history. */
export interface GasHistoryView {
  /** m³ per local day in `[from, to]` (days without consumption may be missing). */
  days(from: string, to: string): Promise<Map<string, number>>;
  /** 5 minute rows `[bucket start s, m³]` of a local day; empty when none are kept. */
  rows(day: string): Promise<Array<[number, number]>>;
}

/** A point in local time: a day, and either a moment (epoch ms) or the end of that day. */
interface Point {
  date: string;
  atMs?: number;
}

export interface Recorded {
  m3: number;
  /** False when part of a day had to be split but its 5 minute rows are no longer kept. */
  exact: boolean;
}

export interface DriftEntry {
  date: string;
  time: string | null;
  m3: number;
  /** The previous reading plus the m³ recorded since it. */
  expectedM3: number;
  /** Reading minus expected: positive means the plugin recorded too little. */
  driftM3: number;
  exact: boolean;
}

/** Epoch ms of the local wall time `HH:MM` on `day` in `timeZone` (DST aware). */
export function localTimeMs(day: string, time: string, timeZone: string): number {
  const [y, m, d] = ymd(day);
  const [hh = 0, mm = 0] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wall - utcOffsetMs(wall, timeZone);
  guess = wall - utcOffsetMs(guess, timeZone);
  return guess;
}

function pointOf(r: MeterReading, timeZone: string): Point {
  return r.time === undefined
    ? { date: r.date }
    : { date: r.date, atMs: localTimeMs(r.date, r.time, timeZone) };
}

/** m³ of `day` in `[fromMs, toMs)`, from its 5 minute rows. */
async function partialDay(
  view: GasHistoryView,
  day: string,
  fromMs: number,
  toMs: number,
): Promise<Recorded> {
  const rows = await view.rows(day);
  if (rows.length === 0) {
    const whole = (await view.days(day, day)).get(day) ?? 0;
    // The day had consumption but its rows are gone: the split is unknown, nothing is added.
    return { m3: 0, exact: whole === 0 };
  }
  let m3 = 0;
  for (const [t, v] of rows) if (t * 1000 >= fromMs && t * 1000 < toMs) m3 += v;
  return { m3, exact: true };
}

/** m³ the plugin recorded after point `a` up to point `b`. */
async function recordedBetween(view: GasHistoryView, a: Point, b: Point): Promise<Recorded> {
  if (a.date > b.date) return { m3: 0, exact: true };
  if (a.date === b.date) {
    if (a.atMs === undefined) return { m3: 0, exact: true };
    return partialDay(view, a.date, a.atMs, b.atMs ?? Number.POSITIVE_INFINITY);
  }
  let m3 = 0;
  let exact = true;
  if (a.atMs !== undefined) {
    const start = await partialDay(view, a.date, a.atMs, Number.POSITIVE_INFINITY);
    m3 += start.m3;
    exact &&= start.exact;
  }
  const firstFull = addDays(a.date, 1);
  const lastFull = addDays(b.date, -1);
  if (firstFull <= lastFull) {
    for (const v of (await view.days(firstFull, lastFull)).values()) m3 += v;
  }
  if (b.atMs === undefined) {
    m3 += (await view.days(b.date, b.date)).get(b.date) ?? 0;
  } else {
    const end = await partialDay(view, b.date, Number.NEGATIVE_INFINITY, b.atMs);
    m3 += end.m3;
    exact &&= end.exact;
  }
  return { m3, exact };
}

/** Readings taken up to `nowMs` (a reading without a time counts once its day has begun). */
export function applicableReadings(
  readings: readonly MeterReading[],
  nowMs: number,
  timeZone: string,
): MeterReading[] {
  const today = dayKey(nowMs, timeZone);
  return readings.filter((r) => {
    if (r.date > today) return false;
    return r.time === undefined || localTimeMs(r.date, r.time, timeZone) <= nowMs;
  });
}

/**
 * The displayed meter reading: the latest applicable reading plus what was
 * recorded after it until now. Undefined without an applicable reading (the
 * caller then shows the device counter).
 */
export async function displayedReading(
  view: GasHistoryView,
  readings: readonly MeterReading[],
  nowMs: number,
  timeZone: string,
): Promise<{ reading: MeterReading; m3: number; exact: boolean } | undefined> {
  const reading = applicableReadings(readings, nowMs, timeZone).at(-1);
  if (!reading) return undefined;
  const today = dayKey(nowMs, timeZone);
  const since = await recordedBetween(view, pointOf(reading, timeZone), { date: today });
  return { reading, m3: roundM3(reading.m3 + since.m3), exact: since.exact };
}

/** For every applicable reading after the first: how far it is from the previous one plus the recorded m³. */
export async function readingDrift(
  view: GasHistoryView,
  readings: readonly MeterReading[],
  nowMs: number,
  timeZone: string,
): Promise<DriftEntry[]> {
  const list = applicableReadings(readings, nowMs, timeZone);
  const out: DriftEntry[] = [];
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    const cur = list[i];
    if (!prev || !cur) continue;
    const rec = await recordedBetween(view, pointOf(prev, timeZone), pointOf(cur, timeZone));
    const expected = roundM3(prev.m3 + rec.m3);
    out.push({
      date: cur.date,
      time: cur.time ?? null,
      m3: cur.m3,
      expectedM3: expected,
      driftM3: roundM3(cur.m3 - expected),
      exact: rec.exact,
    });
  }
  return out;
}

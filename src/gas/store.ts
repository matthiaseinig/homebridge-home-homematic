import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
/** Daily totals are kept this long. */
export const DAYS_RETENTION_YEARS = 10;
import { dayKey } from './dates.js';
import { readJsonOrBackup, writeFileAtomic } from './files.js';

export const BUCKET_SECONDS = 300;

/** Start (epoch seconds) of the 5 minute bucket that contains `epochMs`. */
export function bucketStart(epochMs: number): number {
  return Math.floor(epochMs / 1000 / BUCKET_SECONDS) * BUCKET_SECONDS;
}

export const LIVE_PREFIX = 'power-live-';
export const DAYS_PREFIX = 'power-days-';
const SCHEMA = 1;

/** One 5 minute aggregate: bucket start (epoch s), mean W, max W, energy Wh in the bucket. */
export type Row = [t: number, avgW: number | null, maxW: number | null, wh: number];
/** Energy per series (`<deviceId>|<channel>`) of one local day, Wh. */
export type DayEnergy = Record<string, number>;

interface LiveFile {
  version: number;
  date: string;
  series: Record<string, Row[]>;
}
interface DaysFile {
  version: number;
  month: string;
  days: Record<string, DayEnergy>;
}
interface Open {
  t: number;
  sum: number;
  n: number;
  max: number;
  wh: number;
}

export interface BucketStoreOptions {
  dir: string;
  timeZone: string;
  retentionDays: number;
  now?: () => number;
  onWarn?: (message: string) => void;
  /** File name prefix of the 5 minute files (default `power-live-`). */
  livePrefix?: string;
  /** File name prefix of the month files with the daily totals (default `power-days-`). */
  daysPrefix?: string;
  /** What the files hold, for the warning about an unreadable file (default `power`). */
  label?: string;
}

const PREFIX_PATTERN = /^[a-z][a-z0-9-]{0,30}-$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const round = (n: number, d: number): number => Math.round(n * 10 ** d) / 10 ** d;

function isRow(r: unknown): r is Row {
  return (
    Array.isArray(r) &&
    r.length === 4 &&
    Number.isInteger(r[0]) &&
    (r[1] === null || Number.isFinite(r[1])) &&
    (r[2] === null || Number.isFinite(r[2])) &&
    Number.isFinite(r[3])
  );
}

const isLiveFile = (raw: unknown): raw is LiveFile =>
  isObject(raw) && raw.version === SCHEMA && isObject(raw.series);
const isDaysFile = (raw: unknown): raw is DaysFile =>
  isObject(raw) && raw.version === SCHEMA && isObject(raw.days);

export const seriesKey = (deviceId: string, channel: string): string => `${deviceId}|${channel}`;

/**
 * Local history store. Samples are averaged into 5 minute rows (one file per
 * local day, `power-live-YYYY-MM-DD.json`, kept `retentionDays`) and their
 * energy is summed per local day (one file per month, `power-days-YYYY-MM.json`,
 * kept 10 years). Files are atomic, 0600; an unreadable file is moved aside.
 * The prefixes are options, so other counters (the gas meter: m³ instead of
 * Wh, m³/h instead of W) reuse the store in files of their own.
 */
export class BucketStore {
  private readonly open = new Map<string, Open>();
  private readonly pendingRows = new Map<string, Map<string, Row[]>>();
  private readonly pendingEnergy = new Map<string, DayEnergy>();
  private writing: Promise<void> = Promise.resolve();
  /** Newest sample time seen, epoch ms. */
  lastSample?: number;

  private readonly livePrefix: string;
  private readonly daysPrefix: string;

  constructor(private readonly opts: BucketStoreOptions) {
    this.livePrefix = opts.livePrefix ?? LIVE_PREFIX;
    this.daysPrefix = opts.daysPrefix ?? DAYS_PREFIX;
    // The prefixes go into file names and regular expressions: only plain names are allowed.
    if (!PREFIX_PATTERN.test(this.livePrefix) || !PREFIX_PATTERN.test(this.daysPrefix)) {
      throw new Error('history file prefixes must be lower case letters, digits and dashes');
    }
    if (this.livePrefix === this.daysPrefix) throw new Error('history file prefixes must differ');
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private warnBackup = (backup: string): void =>
    this.opts.onWarn?.(
      `A ${this.opts.label ?? 'power'} history file was unreadable and was moved to ${backup}`,
    );

  /** Add one sample. `powerW` may be missing; `deltaWh` is the energy since the previous sample. */
  record(key: string, tMs: number, powerW: number | undefined, deltaWh: number): void {
    this.lastSample = Math.max(this.lastSample ?? 0, tMs);
    const t = bucketStart(tMs);
    let cur = this.open.get(key);
    if (cur && cur.t !== t) {
      this.close(key, cur);
      cur = undefined;
    }
    cur ??= { t, sum: 0, n: 0, max: -Infinity, wh: 0 };
    if (powerW !== undefined) {
      cur.sum += powerW;
      cur.n += 1;
      cur.max = Math.max(cur.max, powerW);
    }
    cur.wh += deltaWh;
    this.open.set(key, cur);
    if (deltaWh > 0) {
      const date = dayKey(tMs, this.opts.timeZone);
      const day = this.pendingEnergy.get(date) ?? {};
      day[key] = (day[key] ?? 0) + deltaWh;
      this.pendingEnergy.set(date, day);
    }
  }

  private rowOf(o: Open): Row {
    return [
      o.t,
      o.n > 0 ? round(o.sum / o.n, 2) : null,
      o.n > 0 ? round(o.max, 2) : null,
      round(o.wh, 3),
    ];
  }

  private close(key: string, o: Open): void {
    const date = dayKey(o.t * 1000, this.opts.timeZone);
    const byKey = this.pendingRows.get(date) ?? new Map<string, Row[]>();
    byKey.set(key, [...(byKey.get(key) ?? []), this.rowOf(o)]);
    this.pendingRows.set(date, byKey);
    this.open.delete(key);
  }

  /** Persist closed buckets and day energy. `all` also closes the running bucket (shutdown). */
  flush(all = false): Promise<void> {
    const current = bucketStart(this.now());
    for (const [key, o] of [...this.open]) if (all || o.t < current) this.close(key, o);
    const rows = [...this.pendingRows];
    const energy = [...this.pendingEnergy];
    this.pendingRows.clear();
    this.pendingEnergy.clear();
    const task = this.writing.then(async () => {
      for (const [date, byKey] of rows) await this.writeLive(date, byKey);
      const months = new Map<string, Array<[string, DayEnergy]>>();
      for (const e of energy)
        months.set(e[0].slice(0, 7), [...(months.get(e[0].slice(0, 7)) ?? []), e]);
      for (const [month, list] of months) await this.writeMonth(month, list);
    });
    this.writing = task.catch(() => undefined);
    return task;
  }

  private liveFile(date: string): string {
    return join(this.opts.dir, `${this.livePrefix}${date}.json`);
  }
  private daysFile(month: string): string {
    return join(this.opts.dir, `${this.daysPrefix}${month}.json`);
  }

  private async readLiveFile(date: string): Promise<Record<string, Row[]>> {
    const raw = await readJsonOrBackup(
      this.liveFile(date),
      isLiveFile,
      this.warnBackup,
      this.now(),
    );
    const out: Record<string, Row[]> = {};
    for (const [k, rows] of Object.entries(raw?.series ?? {})) {
      if (Array.isArray(rows)) out[k] = rows.filter(isRow);
    }
    return out;
  }

  private async writeLive(date: string, byKey: Map<string, Row[]>): Promise<void> {
    const series = await this.readLiveFile(date);
    for (const [key, add] of byKey) {
      const merged = new Map((series[key] ?? []).map((r) => [r[0], r] as const));
      for (const r of add) merged.set(r[0], r);
      series[key] = [...merged.values()].sort((a, b) => a[0] - b[0]);
    }
    const file: LiveFile = { version: SCHEMA, date, series };
    await writeFileAtomic(this.liveFile(date), JSON.stringify(file));
  }

  private async readMonthFile(month: string): Promise<Record<string, DayEnergy>> {
    const raw = await readJsonOrBackup(
      this.daysFile(month),
      isDaysFile,
      this.warnBackup,
      this.now(),
    );
    const out: Record<string, DayEnergy> = {};
    for (const [d, vals] of Object.entries(raw?.days ?? {})) {
      if (!isObject(vals) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      const clean: DayEnergy = {};
      for (const [k, v] of Object.entries(vals)) {
        if (typeof v === 'number' && Number.isFinite(v)) clean[k] = v;
      }
      out[d] = clean;
    }
    return out;
  }

  private async writeMonth(month: string, adds: Array<[string, DayEnergy]>): Promise<void> {
    const days = await this.readMonthFile(month);
    for (const [date, add] of adds) {
      const day = { ...(days[date] ?? {}) };
      for (const [k, wh] of Object.entries(add)) day[k] = round((day[k] ?? 0) + wh, 3);
      days[date] = day;
    }
    const file: DaysFile = { version: SCHEMA, month, days };
    await writeFileAtomic(this.daysFile(month), JSON.stringify(file));
  }

  private async names(prefix: string): Promise<Array<{ name: string; key: string }>> {
    let names: string[];
    try {
      names = await readdir(this.opts.dir);
    } catch {
      return [];
    }
    const re = new RegExp(`^${prefix}(\\d{4}-\\d{2}(?:-\\d{2})?)\\.json$`);
    return names.flatMap((name) => {
      const m = re.exec(name);
      return m?.[1] ? [{ name, key: m[1] }] : [];
    });
  }

  /** Rows of one device in `[fromSec, toSec]`, per channel, ascending; includes unflushed data. */
  async readLive(deviceId: string, fromSec: number, toSec: number): Promise<Record<string, Row[]>> {
    const from = dayKey(fromSec * 1000, this.opts.timeZone);
    const to = dayKey(toSec * 1000, this.opts.timeZone);
    const merged = new Map<string, Map<number, Row>>();
    const put = (key: string, r: Row): void => {
      if (r[0] < fromSec || r[0] > toSec || !key.startsWith(`${deviceId}|`)) return;
      const ch = key.slice(deviceId.length + 1);
      const m = merged.get(ch) ?? new Map<number, Row>();
      m.set(r[0], r);
      merged.set(ch, m);
    };
    for (const f of await this.names(this.livePrefix)) {
      if (f.key.length !== 10 || f.key < from || f.key > to) continue;
      for (const [k, rows] of Object.entries(await this.readLiveFile(f.key))) {
        for (const r of rows) put(k, r);
      }
    }
    for (const byKey of this.pendingRows.values()) {
      for (const [k, rows] of byKey) for (const r of rows) put(k, r);
    }
    for (const [k, o] of this.open) put(k, this.rowOf(o));
    return Object.fromEntries(
      [...merged].map(([ch, m]) => [ch, [...m.values()].sort((a, b) => a[0] - b[0])]),
    );
  }

  /** Energy per day and series (Wh) for days in `[from, to]`, ascending; includes unflushed data. */
  async readDays(from: string, to: string): Promise<Array<{ date: string; energy: DayEnergy }>> {
    const days = new Map<string, DayEnergy>();
    for (const f of await this.names(this.daysPrefix)) {
      if (f.key.length !== 7 || f.key < from.slice(0, 7) || f.key > to.slice(0, 7)) continue;
      for (const [d, e] of Object.entries(await this.readMonthFile(f.key))) {
        if (d >= from && d <= to) days.set(d, e);
      }
    }
    for (const [d, add] of this.pendingEnergy) {
      if (d < from || d > to) continue;
      const day = { ...(days.get(d) ?? {}) };
      for (const [k, wh] of Object.entries(add)) day[k] = round((day[k] ?? 0) + wh, 3);
      days.set(d, day);
    }
    return [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, energy]) => ({ date, energy }));
  }

  /** Delete 5 minute files older than the retention and day files older than 10 years (with backups). */
  async prune(nowMs: number): Promise<void> {
    const liveCutoff = dayKey(nowMs - this.opts.retentionDays * 86_400_000, this.opts.timeZone);
    const daysCutoff = dayKey(nowMs - DAYS_RETENTION_YEARS * 366 * 86_400_000, this.opts.timeZone);
    let names: string[];
    try {
      names = await readdir(this.opts.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const live = new RegExp(
        `^${this.livePrefix}(\\d{4}-\\d{2}-\\d{2})\\.json(?:\\.bak-\\d+)?$`,
      ).exec(name);
      const days = new RegExp(`^${this.daysPrefix}(\\d{4}-\\d{2})\\.json(?:\\.bak-\\d+)?$`).exec(
        name,
      );
      if ((live?.[1] !== undefined && live[1] < liveCutoff) || (days?.[1] !== undefined && days[1] < daysCutoff.slice(0, 7))) {
        await rm(join(this.opts.dir, name), { force: true });
      }
    }
  }

  get bucketSeconds(): number {
    return BUCKET_SECONDS;
  }
}

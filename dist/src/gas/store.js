import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
/** Daily totals are kept this long. */
export const DAYS_RETENTION_YEARS = 10;
import { dayKey } from './dates.js';
import { readJsonOrBackup, writeFileAtomic } from './files.js';
export const BUCKET_SECONDS = 300;
/** Start (epoch seconds) of the 5 minute bucket that contains `epochMs`. */
export function bucketStart(epochMs) {
    return Math.floor(epochMs / 1000 / BUCKET_SECONDS) * BUCKET_SECONDS;
}
export const LIVE_PREFIX = 'power-live-';
export const DAYS_PREFIX = 'power-days-';
const SCHEMA = 1;
const PREFIX_PATTERN = /^[a-z][a-z0-9-]{0,30}-$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
function isRow(r) {
    return (Array.isArray(r) &&
        r.length === 4 &&
        Number.isInteger(r[0]) &&
        (r[1] === null || Number.isFinite(r[1])) &&
        (r[2] === null || Number.isFinite(r[2])) &&
        Number.isFinite(r[3]));
}
const isLiveFile = (raw) => isObject(raw) && raw.version === SCHEMA && isObject(raw.series);
const isDaysFile = (raw) => isObject(raw) && raw.version === SCHEMA && isObject(raw.days);
export const seriesKey = (deviceId, channel) => `${deviceId}|${channel}`;
/**
 * Local history store. Samples are averaged into 5 minute rows (one file per
 * local day, `power-live-YYYY-MM-DD.json`, kept `retentionDays`) and their
 * energy is summed per local day (one file per month, `power-days-YYYY-MM.json`,
 * kept 10 years). Files are atomic, 0600; an unreadable file is moved aside.
 * The prefixes are options, so other counters (the gas meter: m³ instead of
 * Wh, m³/h instead of W) reuse the store in files of their own.
 */
export class BucketStore {
    opts;
    open = new Map();
    pendingRows = new Map();
    pendingEnergy = new Map();
    writing = Promise.resolve();
    /** Newest sample time seen, epoch ms. */
    lastSample;
    livePrefix;
    daysPrefix;
    constructor(opts) {
        this.opts = opts;
        this.livePrefix = opts.livePrefix ?? LIVE_PREFIX;
        this.daysPrefix = opts.daysPrefix ?? DAYS_PREFIX;
        // The prefixes go into file names and regular expressions: only plain names are allowed.
        if (!PREFIX_PATTERN.test(this.livePrefix) || !PREFIX_PATTERN.test(this.daysPrefix)) {
            throw new Error('history file prefixes must be lower case letters, digits and dashes');
        }
        if (this.livePrefix === this.daysPrefix)
            throw new Error('history file prefixes must differ');
    }
    now() {
        return (this.opts.now ?? Date.now)();
    }
    warnBackup = (backup) => this.opts.onWarn?.(`A ${this.opts.label ?? 'power'} history file was unreadable and was moved to ${backup}`);
    /** Add one sample. `powerW` may be missing; `deltaWh` is the energy since the previous sample. */
    record(key, tMs, powerW, deltaWh) {
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
    rowOf(o) {
        return [
            o.t,
            o.n > 0 ? round(o.sum / o.n, 2) : null,
            o.n > 0 ? round(o.max, 2) : null,
            round(o.wh, 3),
        ];
    }
    close(key, o) {
        const date = dayKey(o.t * 1000, this.opts.timeZone);
        const byKey = this.pendingRows.get(date) ?? new Map();
        byKey.set(key, [...(byKey.get(key) ?? []), this.rowOf(o)]);
        this.pendingRows.set(date, byKey);
        this.open.delete(key);
    }
    /** Persist closed buckets and day energy. `all` also closes the running bucket (shutdown). */
    flush(all = false) {
        const current = bucketStart(this.now());
        for (const [key, o] of [...this.open])
            if (all || o.t < current)
                this.close(key, o);
        const rows = [...this.pendingRows];
        const energy = [...this.pendingEnergy];
        this.pendingRows.clear();
        this.pendingEnergy.clear();
        const task = this.writing.then(async () => {
            for (const [date, byKey] of rows)
                await this.writeLive(date, byKey);
            const months = new Map();
            for (const e of energy)
                months.set(e[0].slice(0, 7), [...(months.get(e[0].slice(0, 7)) ?? []), e]);
            for (const [month, list] of months)
                await this.writeMonth(month, list);
        });
        this.writing = task.catch(() => undefined);
        return task;
    }
    liveFile(date) {
        return join(this.opts.dir, `${this.livePrefix}${date}.json`);
    }
    daysFile(month) {
        return join(this.opts.dir, `${this.daysPrefix}${month}.json`);
    }
    async readLiveFile(date) {
        const raw = await readJsonOrBackup(this.liveFile(date), isLiveFile, this.warnBackup, this.now());
        const out = {};
        for (const [k, rows] of Object.entries(raw?.series ?? {})) {
            if (Array.isArray(rows))
                out[k] = rows.filter(isRow);
        }
        return out;
    }
    async writeLive(date, byKey) {
        const series = await this.readLiveFile(date);
        for (const [key, add] of byKey) {
            const merged = new Map((series[key] ?? []).map((r) => [r[0], r]));
            for (const r of add)
                merged.set(r[0], r);
            series[key] = [...merged.values()].sort((a, b) => a[0] - b[0]);
        }
        const file = { version: SCHEMA, date, series };
        await writeFileAtomic(this.liveFile(date), JSON.stringify(file));
    }
    async readMonthFile(month) {
        const raw = await readJsonOrBackup(this.daysFile(month), isDaysFile, this.warnBackup, this.now());
        const out = {};
        for (const [d, vals] of Object.entries(raw?.days ?? {})) {
            if (!isObject(vals) || !/^\d{4}-\d{2}-\d{2}$/.test(d))
                continue;
            const clean = {};
            for (const [k, v] of Object.entries(vals)) {
                if (typeof v === 'number' && Number.isFinite(v))
                    clean[k] = v;
            }
            out[d] = clean;
        }
        return out;
    }
    async writeMonth(month, adds) {
        const days = await this.readMonthFile(month);
        for (const [date, add] of adds) {
            const day = { ...(days[date] ?? {}) };
            for (const [k, wh] of Object.entries(add))
                day[k] = round((day[k] ?? 0) + wh, 3);
            days[date] = day;
        }
        const file = { version: SCHEMA, month, days };
        await writeFileAtomic(this.daysFile(month), JSON.stringify(file));
    }
    async names(prefix) {
        let names;
        try {
            names = await readdir(this.opts.dir);
        }
        catch {
            return [];
        }
        const re = new RegExp(`^${prefix}(\\d{4}-\\d{2}(?:-\\d{2})?)\\.json$`);
        return names.flatMap((name) => {
            const m = re.exec(name);
            return m?.[1] ? [{ name, key: m[1] }] : [];
        });
    }
    /** Rows of one device in `[fromSec, toSec]`, per channel, ascending; includes unflushed data. */
    async readLive(deviceId, fromSec, toSec) {
        const from = dayKey(fromSec * 1000, this.opts.timeZone);
        const to = dayKey(toSec * 1000, this.opts.timeZone);
        const merged = new Map();
        const put = (key, r) => {
            if (r[0] < fromSec || r[0] > toSec || !key.startsWith(`${deviceId}|`))
                return;
            const ch = key.slice(deviceId.length + 1);
            const m = merged.get(ch) ?? new Map();
            m.set(r[0], r);
            merged.set(ch, m);
        };
        for (const f of await this.names(this.livePrefix)) {
            if (f.key.length !== 10 || f.key < from || f.key > to)
                continue;
            for (const [k, rows] of Object.entries(await this.readLiveFile(f.key))) {
                for (const r of rows)
                    put(k, r);
            }
        }
        for (const byKey of this.pendingRows.values()) {
            for (const [k, rows] of byKey)
                for (const r of rows)
                    put(k, r);
        }
        for (const [k, o] of this.open)
            put(k, this.rowOf(o));
        return Object.fromEntries([...merged].map(([ch, m]) => [ch, [...m.values()].sort((a, b) => a[0] - b[0])]));
    }
    /** Energy per day and series (Wh) for days in `[from, to]`, ascending; includes unflushed data. */
    async readDays(from, to) {
        const days = new Map();
        for (const f of await this.names(this.daysPrefix)) {
            if (f.key.length !== 7 || f.key < from.slice(0, 7) || f.key > to.slice(0, 7))
                continue;
            for (const [d, e] of Object.entries(await this.readMonthFile(f.key))) {
                if (d >= from && d <= to)
                    days.set(d, e);
            }
        }
        for (const [d, add] of this.pendingEnergy) {
            if (d < from || d > to)
                continue;
            const day = { ...(days.get(d) ?? {}) };
            for (const [k, wh] of Object.entries(add))
                day[k] = round((day[k] ?? 0) + wh, 3);
            days.set(d, day);
        }
        return [...days]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, energy]) => ({ date, energy }));
    }
    /** Delete 5 minute files older than the retention and day files older than 10 years (with backups). */
    async prune(nowMs) {
        const liveCutoff = dayKey(nowMs - this.opts.retentionDays * 86_400_000, this.opts.timeZone);
        const daysCutoff = dayKey(nowMs - DAYS_RETENTION_YEARS * 366 * 86_400_000, this.opts.timeZone);
        let names;
        try {
            names = await readdir(this.opts.dir);
        }
        catch {
            return;
        }
        for (const name of names) {
            const live = new RegExp(`^${this.livePrefix}(\\d{4}-\\d{2}-\\d{2})\\.json(?:\\.bak-\\d+)?$`).exec(name);
            const days = new RegExp(`^${this.daysPrefix}(\\d{4}-\\d{2})\\.json(?:\\.bak-\\d+)?$`).exec(name);
            if ((live?.[1] !== undefined && live[1] < liveCutoff) || (days?.[1] !== undefined && days[1] < daysCutoff.slice(0, 7))) {
                await rm(join(this.opts.dir, name), { force: true });
            }
        }
    }
    get bucketSeconds() {
        return BUCKET_SECONDS;
    }
}
//# sourceMappingURL=store.js.map
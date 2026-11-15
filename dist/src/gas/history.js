import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { addDays, dayKey, dayStartMs } from './dates.js';
import { readJsonOrBackup, writeFileAtomic } from './files.js';
import { BucketStore, seriesKey } from './store.js';
import { roundKwh, roundM3 } from './factors.js';
export const GAS_LIVE_PREFIX = 'gas-live-';
export const GAS_DAYS_PREFIX = 'gas-days-';
export const GAS_STATE_FILE = 'gas-state.json';
/** The one series of the gas meter in the store (`gas|m3`); not tied to the device, so a new device continues it. */
export const GAS_SERIES_ID = 'gas';
export const GAS_SERIES_CHANNEL = 'm3';
export const GAS_SERIES = seriesKey(GAS_SERIES_ID, GAS_SERIES_CHANNEL);
const STATE_SCHEMA = 1;
/** Past day ranges kept in memory (the meter reading needs the same ranges every poll). */
const MAX_CACHED_RANGES = 64;
/**
 * A short one-way fingerprint of host and credentials, so a saved login
 * backoff is dropped when the owner fixes the password. config.json holds the
 * password in clear anyway; the fingerprint adds nothing an attacker could use.
 */
export function credentialKey(host, username, password) {
    return createHash('sha256')
        .update(`gas-login\n${host}\n${username}\n${password}`)
        .digest('hex')
        .slice(0, 16);
}
const isState = (raw) => raw !== null &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    raw.version === STATE_SCHEMA;
const fin = (v) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
/**
 * The gas meter's history: 5 minute rows (mean and max m³/h, m³) and daily m³
 * in a BucketStore with files of their own (`gas-live-*`, `gas-days-*`), plus
 * the saved counter baseline (`gas-state.json`). kWh are never stored; they
 * are computed from m³ and the factor of each day when read.
 */
export class GasHistory {
    opts;
    store;
    pastDays = new Map();
    pastFor = '';
    constructor(opts) {
        this.opts = opts;
        this.store = new BucketStore({
            dir: opts.dir,
            timeZone: opts.timeZone,
            retentionDays: opts.retentionDays,
            now: opts.now,
            onWarn: opts.onWarn,
            livePrefix: GAS_LIVE_PREFIX,
            daysPrefix: GAS_DAYS_PREFIX,
            label: 'gas',
        });
    }
    get stateFile() {
        return join(this.opts.dir, GAS_STATE_FILE);
    }
    /** The saved counter baseline (none: the first sample only sets it) and login backoff. */
    async loadState() {
        const raw = await readJsonOrBackup(this.stateFile, isState, (b) => this.opts.onWarn(`The gas meter state was unreadable and was moved to ${b}`), this.opts.now());
        const counter = fin(raw?.counter);
        const at = fin(raw?.at);
        const failures = fin(raw?.auth?.failures);
        const blockedUntil = fin(raw?.auth?.blockedUntil);
        const key = raw?.auth?.key;
        return {
            counter: counter !== undefined && at !== undefined ? { counter, at } : {},
            ...(failures !== undefined && blockedUntil !== undefined && typeof key === 'string'
                ? { auth: { failures, blockedUntil, key } }
                : {}),
        };
    }
    /** Writes are queued: the poll and a login failure may save at the same time. */
    stateWrite = Promise.resolve();
    saveState(state) {
        const file = {
            version: STATE_SCHEMA,
            counter: state.counter.counter,
            at: state.counter.at,
            ...(state.auth && state.auth.failures > 0 ? { auth: state.auth } : {}),
        };
        const task = this.stateWrite.then(() => writeFileAtomic(this.stateFile, JSON.stringify(file)));
        this.stateWrite = task.catch(() => undefined);
        return task;
    }
    record(tMs, flowM3h, deltaM3) {
        this.store.record(GAS_SERIES, tMs, flowM3h, deltaM3);
    }
    /** m³ per local day in `[from, to]`. Days before today are cached for the day. */
    async days(from, to) {
        const today = dayKey(this.opts.now(), this.opts.timeZone);
        if (today !== this.pastFor) {
            this.pastDays.clear();
            this.pastFor = today;
        }
        const cacheKey = `${from}|${to}`;
        const cached = to < today ? this.pastDays.get(cacheKey) : undefined;
        if (cached)
            return cached;
        const out = new Map();
        for (const { date, energy } of await this.store.readDays(from, to)) {
            const m3 = energy[GAS_SERIES];
            if (m3 !== undefined)
                out.set(date, m3);
        }
        if (to < today) {
            if (this.pastDays.size >= MAX_CACHED_RANGES)
                this.pastDays.clear();
            this.pastDays.set(cacheKey, out);
        }
        return out;
    }
    /** Rows `[t, avgM3h, maxM3h, m3]` of a local day (includes the open bucket). */
    async liveRows(day) {
        const from = dayStartMs(day, this.opts.timeZone) / 1000;
        const to = dayStartMs(addDays(day, 1), this.opts.timeZone) / 1000 - 1;
        return (await this.store.readLive(GAS_SERIES_ID, from, to))[GAS_SERIES_CHANNEL] ?? [];
    }
    async rows(day) {
        return (await this.liveRows(day)).map((r) => [r[0], r[3]]);
    }
    /**
     * Today, yesterday and this month. A day is known when it has consumption or
     * recorded rows; the month counts its days with consumption plus today.
     */
    async summary() {
        const { factors, timeZone } = this.opts;
        const today = dayKey(this.opts.now(), timeZone);
        const yesterday = addDays(today, -1);
        const monthStart = `${today.slice(0, 7)}-01`;
        const days = await this.days(monthStart < yesterday ? monthStart : yesterday, today);
        const known = async (day) => days.get(day) ?? ((await this.liveRows(day)).length > 0 ? 0 : undefined);
        const todayM3 = await known(today);
        const yesterdayM3 = await known(yesterday);
        const month = [...days].filter(([d]) => d >= monthStart && d <= today);
        const monthKnown = month.length > 0 || todayM3 !== undefined;
        const monthM3 = month.reduce((a, [, v]) => a + v, 0);
        const monthKwh = month.reduce((a, [d, v]) => a + v * factors.forDay(d).kwhPerM3, 0);
        return {
            todayM3: todayM3 === undefined ? undefined : roundM3(todayM3),
            yesterdayM3: yesterdayM3 === undefined ? undefined : roundM3(yesterdayM3),
            monthM3: monthKnown ? roundM3(monthM3) : undefined,
            monthKwh: monthKnown ? roundKwh(monthKwh) : undefined,
            factor: factors.forDay(today).kwhPerM3,
        };
    }
    flush(all = false) {
        return this.store.flush(all);
    }
    prune(nowMs) {
        return this.store.prune(nowMs);
    }
}
//# sourceMappingURL=history.js.map
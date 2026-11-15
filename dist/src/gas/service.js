import { ccuBool, ccuNumber, GasCcuError } from './ccuReader.js';
import { counterStep } from './counter.js';
import { checkDatapoints } from './datapoints.js';
import { dayKey } from './dates.js';
import { GasFactors } from './factors.js';
import { GasHistory } from './history.js';
import { displayedReading } from './readings.js';
/** The meter cannot pass more than this per hour; larger steps are dropped and re-based. */
export const GAS_LIMITS = {
    maxPerHour: 10,
    slack: 0.05,
    holdZero: true,
    // The sensor restarts at 0 (battery change, wrap): a lower value of 1 m³ or more is a read glitch.
    resetBelow: 1,
};
/** After this many polls in a row that hold the same or a rising value below the baseline, it becomes the new baseline. */
export const GAS_REBASE_AFTER = 10;
export const GAS_FLUSH_INTERVAL_MS = 5 * 60_000;
/** 5 minute rows are kept this many days. */
export const GAS_LIVE_RETENTION_DAYS = 90;
/**
 * Polls the gas meter through the plugin's CCU session (read-only
 * allow-list, see ccuReader.ts), records counter steps as m³ and publishes
 * the HomeKit values. While the device is unreachable nothing is recorded
 * and the counter baseline is kept. Polling needs no XML-RPC event port.
 */
export class GasService {
    settings;
    log;
    deps;
    history;
    factors;
    reader;
    reading = { ccuOk: false };
    datapoints = { checked: false };
    state = {};
    /** Consecutive held readings above 0 and below the baseline, and the last of them. */
    low = { count: 0, value: 0 };
    auth;
    now;
    setTimer;
    clearTimer;
    timers = [];
    polling;
    stopped = false;
    lastPrune = '';
    warned = new Set();
    /** Settles after the start-up datapoint check and the first poll. */
    ready = Promise.resolve();
    constructor(settings, storageDir, log, deps) {
        this.settings = settings;
        this.log = log;
        this.deps = deps;
        this.now = deps.now ?? Date.now;
        this.setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
        this.clearTimer = deps.clearTimer ?? ((h) => clearInterval(h));
        this.factors = new GasFactors({ calorificValue: settings.calorificValue, zNumber: settings.zNumber }, settings.factorPeriods);
        this.history = new GasHistory({
            dir: storageDir,
            timeZone: settings.timeZone,
            retentionDays: GAS_LIVE_RETENTION_DAYS,
            factors: this.factors,
            now: this.now,
            onWarn: (m) => this.log.warn('%s', m),
        });
        this.reader = deps.reader;
        this.reader.onAuthState = (auth) => {
            this.auth = auth;
            this.saveState().catch((e) => this.log.warn('Could not save the gas meter state: %s', e.message));
        };
    }
    get timeZone() {
        return this.settings.timeZone;
    }
    saveState() {
        return this.history.saveState({
            counter: this.state,
            ...(this.auth ? { auth: { ...this.auth, key: this.deps.authKey } } : {}),
        });
    }
    get channelAddress() {
        return `${this.settings.address}:${this.settings.channel}`;
    }
    async start() {
        const saved = await this.history.loadState();
        this.state = saved.counter;
        if (saved.auth && saved.auth.key === this.deps.authKey) {
            this.auth = { failures: saved.auth.failures, blockedUntil: saved.auth.blockedUntil };
            this.reader.restoreAuthState(this.auth);
        }
        void this.history.prune(this.now()).catch(() => undefined);
        const every = (fn, ms) => {
            const handle = this.setTimer(() => void fn().catch((e) => this.fail(e)), ms);
            handle?.unref?.();
            this.timers.push(handle);
        };
        every(() => this.pollOnce(), this.settings.pollIntervalMs);
        every(() => this.flush(), GAS_FLUSH_INTERVAL_MS);
        this.log.info('Gas meter: polling the CCU every %d s (read-only).', this.settings.pollIntervalMs / 1000);
        this.ready = (async () => {
            await this.check();
            await this.pollOnce();
        })().catch((e) => this.fail(e));
    }
    fail(err) {
        this.log.error('Gas meter: %s', err.message);
    }
    /** Read the channel's paramset description once and say whether the datapoints exist. */
    async check() {
        if (this.stopped)
            return;
        try {
            const raw = await this.reader.describeValues(this.settings.iface, this.channelAddress);
            this.datapoints = checkDatapoints(raw, this.settings);
            for (const line of this.datapoints.messages ?? []) {
                if (this.datapoints.found)
                    this.log.info('Gas meter: %s', line);
                else
                    this.log.warn('Gas meter: %s', line);
            }
        }
        catch (err) {
            this.log.warn('Gas meter: could not read the datapoint description of the channel: %s', err.message);
        }
    }
    /** One poll; concurrent calls share it. */
    pollOnce() {
        if (this.stopped)
            return Promise.resolve();
        this.polling ??= this.poll().finally(() => {
            this.polling = undefined;
        });
        return this.polling;
    }
    /** A channel 0 flag; a datapoint the CCU does not know is undefined (warned once), other errors fail the poll. */
    async flag(key) {
        try {
            return ccuBool(await this.reader.getValue(this.settings.iface, `${this.settings.address}:0`, key));
        }
        catch (err) {
            if (!(err instanceof GasCcuError) || err.kind !== 'protocol')
                throw err;
            if (!this.warned.has(key)) {
                this.warned.add(key);
                this.log.warn('Gas meter: %s of channel 0 is not readable: %s', key, err.message);
            }
            return undefined;
        }
    }
    async poll() {
        const r = this.reading;
        try {
            const unreach = await this.flag('UNREACH');
            const reachable = unreach === undefined ? undefined : !unreach;
            // A device that does not answer makes getParamset fail with a general
            // error; with UNREACH set the paramset is not requested at all.
            const values = reachable === false ? undefined : await this.reader.getValues(this.settings.iface, this.channelAddress);
            const lowBattery = reachable === false ? undefined : await this.flag('LOWBAT');
            if (!r.ccuOk && r.lastError !== undefined)
                this.log.info('Gas meter: CCU readable again.');
            Object.assign(r, { ccuOk: true, reachable, lowBattery, lastError: undefined });
            if (values === undefined) {
                r.flowM3h = undefined;
                r.counterM3 = undefined;
            }
            else {
                this.recordValues(values);
            }
        }
        catch (err) {
            const message = err.message;
            if (r.lastError !== message)
                this.log.warn('Gas meter: CCU not readable: %s', message);
            Object.assign(r, {
                ccuOk: false,
                reachable: undefined,
                lowBattery: undefined,
                flowM3h: undefined,
                counterM3: undefined,
                lastError: message,
            });
        }
        await this.publish();
    }
    recordValues(values) {
        const now = this.now();
        const counter = ccuNumber(values[this.settings.counterDatapoint]);
        const flow = ccuNumber(values[this.settings.flowDatapoint]);
        const r = this.reading;
        r.flowM3h = flow !== undefined && flow >= 0 ? flow : undefined;
        r.counterM3 = counter !== undefined && counter >= 0 ? counter : undefined;
        r.lastUpdate = now;
        let delta = 0;
        if (r.counterM3 !== undefined) {
            const step = counterStep(this.state, r.counterM3, now, GAS_LIMITS);
            if (step.hold) {
                this.holdLow(r.counterM3, now);
            }
            else {
                this.state = { counter: r.counterM3, at: now };
                this.low = { count: 0, value: 0 };
            }
            if (step.reset)
                this.log.info('Gas meter: counter restarted (battery change or wrap)');
            if (step.glitch && !step.hold)
                this.log.warn('Gas meter: implausible counter jump ignored');
            delta = step.delta;
        }
        this.history.record(now, r.flowM3h, delta);
        const today = dayKey(now, this.timeZone);
        if (today !== this.lastPrune) {
            this.lastPrune = today;
            void this.history.prune(now).catch(() => undefined);
        }
    }
    /**
     * A held reading: a 0 waits for the next reading; a drop to 1 m³ or more is
     * a read glitch. If the counter stays at such a lower level (same or rising
     * for GAS_REBASE_AFTER polls, for example a replaced device) it becomes the
     * new baseline, without counting anything.
     */
    holdLow(counter, now) {
        if (counter === 0) {
            this.log.debug('Gas meter: counter read 0, held until the next reading');
            return;
        }
        const consistent = this.low.count > 0 && counter >= this.low.value;
        this.low = { count: consistent ? this.low.count + 1 : 1, value: counter };
        if (this.low.count === 1) {
            this.log.warn('Gas meter: counter below the baseline ignored as a read glitch');
        }
        if (this.low.count >= GAS_REBASE_AFTER) {
            this.log.warn('Gas meter: counter stays below the old baseline; re-based without counting');
            this.state = { counter, at: now };
            this.low = { count: 0, value: 0 };
        }
    }
    /** The HomeKit values as of the last poll. */
    async values() {
        const r = this.reading;
        const s = await this.history.summary();
        const deviceOk = r.ccuOk && r.reachable !== false;
        let meter;
        if (deviceOk && r.counterM3 !== undefined) {
            const shown = await displayedReading(this.history, this.settings.meterReadings, this.now(), this.timeZone);
            meter = shown?.m3 ?? r.counterM3;
        }
        return {
            GasFlow: deviceOk ? r.flowM3h : undefined,
            GasMeterReading: meter,
            GasToday: s.todayM3,
            GasYesterday: s.yesterdayM3,
            GasMonth: s.monthM3,
            GasMonthKwh: s.monthKwh,
            GasFactor: s.factor,
            GasReachable: r.ccuOk ? r.reachable : undefined,
            GasLowBattery: r.ccuOk ? r.lowBattery : undefined,
            LastUpdate: r.lastUpdate === undefined ? undefined : Math.floor(r.lastUpdate / 1000),
        };
    }
    async publish() {
        if (!this.deps.onValues)
            return;
        try {
            this.deps.onValues(await this.values());
        }
        catch (err) {
            this.log.warn('Gas meter: could not update HomeKit: %s', err.message);
        }
    }
    /** Persist the counter baseline first, then the buckets: a crash then loses, never doubles, m³. */
    async flush(all = false) {
        if (this.state.counter !== undefined || this.auth)
            await this.saveState();
        await this.history.flush(all);
    }
    /**
     * Stop polling, wait for a running poll and persist everything. The shared
     * CCU session is logged out by the CCU client when the plugin stops.
     */
    async stop() {
        this.stopped = true;
        for (const t of this.timers)
            this.clearTimer(t);
        this.timers = [];
        await this.polling?.catch(() => undefined);
        await this.flush(true);
    }
}
//# sourceMappingURL=service.js.map
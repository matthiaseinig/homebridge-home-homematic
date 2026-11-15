import type { PrefixedLogger } from '../util/logger.js';
import { ccuBool, ccuNumber, GasCcuError, type AuthState, type GasCcuReader } from './ccuReader.js';
import type { GasSettings } from './config.js';
import { counterStep, type CounterLimits, type CounterState } from './counter.js';
import { checkDatapoints, type DatapointCheck } from './datapoints.js';
import { dayKey } from './dates.js';
import type { CharValues } from './definitions.js';
import { GasFactors } from './factors.js';
import { GasHistory } from './history.js';
import { displayedReading } from './readings.js';

/** The meter cannot pass more than this per hour; larger steps are dropped and re-based. */
export const GAS_LIMITS: CounterLimits = {
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

export interface GasServiceDeps {
  reader: GasCcuReader;
  /** Fingerprint of CCU host and credentials; a saved backoff is used only for the same one. */
  authKey: string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Receives the HomeKit values after every poll. */
  onValues?: (values: CharValues) => void;
}

/** What the last poll saw. `undefined` means not known on that poll. */
export interface GasReading {
  ccuOk: boolean;
  reachable?: boolean;
  lowBattery?: boolean;
  flowM3h?: number;
  counterM3?: number;
  /** Epoch ms of the last poll in which the device answered. */
  lastUpdate?: number;
  lastError?: string;
}

/**
 * Polls the gas meter through the plugin's CCU session (read-only
 * allow-list, see ccuReader.ts), records counter steps as m³ and publishes
 * the HomeKit values. While the device is unreachable nothing is recorded
 * and the counter baseline is kept. Polling needs no XML-RPC event port.
 */
export class GasService {
  readonly history: GasHistory;
  readonly factors: GasFactors;
  readonly reader: GasCcuReader;
  readonly reading: GasReading = { ccuOk: false };
  datapoints: DatapointCheck = { checked: false };
  private state: CounterState = {};
  /** Consecutive held readings above 0 and below the baseline, and the last of them. */
  private low = { count: 0, value: 0 };
  private auth: AuthState | undefined;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private timers: unknown[] = [];
  private polling: Promise<void> | undefined;
  private stopped = false;
  private lastPrune = '';
  private readonly warned = new Set<string>();
  /** Settles after the start-up datapoint check and the first poll. */
  ready: Promise<void> = Promise.resolve();

  constructor(
    readonly settings: GasSettings,
    storageDir: string,
    private readonly log: PrefixedLogger,
    private readonly deps: GasServiceDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.factors = new GasFactors(
      { calorificValue: settings.calorificValue, zNumber: settings.zNumber },
      settings.factorPeriods,
    );
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
      this.saveState().catch((e: Error) => this.log.warn('Could not save the gas meter state: %s', e.message));
    };
  }

  get timeZone(): string {
    return this.settings.timeZone;
  }

  private saveState(): Promise<void> {
    return this.history.saveState({
      counter: this.state,
      ...(this.auth ? { auth: { ...this.auth, key: this.deps.authKey } } : {}),
    });
  }

  private get channelAddress(): string {
    return `${this.settings.address}:${this.settings.channel}`;
  }

  async start(): Promise<void> {
    const saved = await this.history.loadState();
    this.state = saved.counter;
    if (saved.auth && saved.auth.key === this.deps.authKey) {
      this.auth = { failures: saved.auth.failures, blockedUntil: saved.auth.blockedUntil };
      this.reader.restoreAuthState(this.auth);
    }
    void this.history.prune(this.now()).catch(() => undefined);
    const every = (fn: () => Promise<void>, ms: number): void => {
      const handle = this.setTimer(() => void fn().catch((e: Error) => this.fail(e)), ms);
      (handle as { unref?: () => void } | undefined)?.unref?.();
      this.timers.push(handle);
    };
    every(() => this.pollOnce(), this.settings.pollIntervalMs);
    every(() => this.flush(), GAS_FLUSH_INTERVAL_MS);
    this.log.info('Gas meter: polling the CCU every %d s (read-only).', this.settings.pollIntervalMs / 1000);
    this.ready = (async () => {
      await this.check();
      await this.pollOnce();
    })().catch((e: Error) => this.fail(e));
  }

  private fail(err: Error): void {
    this.log.error('Gas meter: %s', err.message);
  }

  /** Read the channel's paramset description once and say whether the datapoints exist. */
  private async check(): Promise<void> {
    if (this.stopped) return;
    try {
      const raw = await this.reader.describeValues(this.settings.iface, this.channelAddress);
      this.datapoints = checkDatapoints(raw, this.settings);
      for (const line of this.datapoints.messages ?? []) {
        if (this.datapoints.found) this.log.info('Gas meter: %s', line);
        else this.log.warn('Gas meter: %s', line);
      }
    } catch (err) {
      this.log.warn('Gas meter: could not read the datapoint description of the channel: %s', (err as Error).message);
    }
  }

  /** One poll; concurrent calls share it. */
  pollOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.polling ??= this.poll().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  /** A channel 0 flag; a datapoint the CCU does not know is undefined (warned once), other errors fail the poll. */
  private async flag(key: string): Promise<boolean | undefined> {
    try {
      return ccuBool(await this.reader.getValue(this.settings.iface, `${this.settings.address}:0`, key));
    } catch (err) {
      if (!(err instanceof GasCcuError) || err.kind !== 'protocol') throw err;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.log.warn('Gas meter: %s of channel 0 is not readable: %s', key, err.message);
      }
      return undefined;
    }
  }

  /**
   * The channel's VALUES. A sender the CCU has not heard since it started
   * (RSSI_DEVICE -65535, UNREACH 0) has no value for any datapoint: the CCU
   * answers every read of the channel with a general error. That is no CCU
   * failure; it is "no reading yet", and the next telegram ends it.
   */
  private async readValues(): Promise<Record<string, unknown> | undefined> {
    try {
      return await this.reader.getValues(this.settings.iface, this.channelAddress);
    } catch (err) {
      if (!(err instanceof GasCcuError) || err.kind !== 'protocol' || !/general error/i.test(err.message)) throw err;
      if (!this.warned.has('NOVALUE')) {
        this.warned.add('NOVALUE');
        this.log.info('Gas meter: the CCU has no value yet for the gas sensor channel (no telegram received since the CCU started); waiting.');
      }
      return undefined;
    }
  }

  private async poll(): Promise<void> {
    const r = this.reading;
    try {
      const unreach = await this.flag('UNREACH');
      const reachable = unreach === undefined ? undefined : !unreach;
      // A device that does not answer makes getParamset fail with a general
      // error; with UNREACH set the paramset is not requested at all.
      const values = reachable === false ? undefined : await this.readValues();
      const lowBattery = reachable === false ? undefined : await this.flag('LOWBAT');
      if (!r.ccuOk && r.lastError !== undefined) this.log.info('Gas meter: CCU readable again.');
      Object.assign(r, { ccuOk: true, reachable, lowBattery, lastError: undefined });
      if (values === undefined) {
        r.flowM3h = undefined;
        r.counterM3 = undefined;
      } else {
        this.recordValues(values);
      }
    } catch (err) {
      const message = (err as Error).message;
      if (r.lastError !== message) this.log.warn('Gas meter: CCU not readable: %s', message);
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

  private recordValues(values: Record<string, unknown>): void {
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
      } else {
        this.state = { counter: r.counterM3, at: now };
        this.low = { count: 0, value: 0 };
      }
      if (step.reset) this.log.info('Gas meter: counter restarted (battery change or wrap)');
      if (step.glitch && !step.hold) this.log.warn('Gas meter: implausible counter jump ignored');
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
  private holdLow(counter: number, now: number): void {
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
  async values(): Promise<CharValues> {
    const r = this.reading;
    const s = await this.history.summary();
    const deviceOk = r.ccuOk && r.reachable !== false;
    let meter: number | undefined;
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

  private async publish(): Promise<void> {
    if (!this.deps.onValues) return;
    try {
      this.deps.onValues(await this.values());
    } catch (err) {
      this.log.warn('Gas meter: could not update HomeKit: %s', (err as Error).message);
    }
  }

  /** Persist the counter baseline first, then the buckets: a crash then loses, never doubles, m³. */
  async flush(all = false): Promise<void> {
    if (this.state.counter !== undefined || this.auth) await this.saveState();
    await this.history.flush(all);
  }

  /**
   * Stop polling, wait for a running poll and persist everything. The shared
   * CCU session is logged out by the CCU client when the plugin stops.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) this.clearTimer(t);
    this.timers = [];
    await this.polling?.catch(() => undefined);
    await this.flush(true);
  }
}

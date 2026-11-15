import type { AuthState } from './ccuReader.js';
import { BucketStore, type Row } from './store.js';
import type { CounterState } from './counter.js';
import type { GasHistoryView } from './readings.js';
import { type GasFactors } from './factors.js';
export declare const GAS_LIVE_PREFIX = "gas-live-";
export declare const GAS_DAYS_PREFIX = "gas-days-";
export declare const GAS_STATE_FILE = "gas-state.json";
/** The one series of the gas meter in the store (`gas|m3`); not tied to the device, so a new device continues it. */
export declare const GAS_SERIES_ID = "gas";
export declare const GAS_SERIES_CHANNEL = "m3";
export declare const GAS_SERIES: string;
export interface GasSummary {
    todayM3?: number;
    yesterdayM3?: number;
    monthM3?: number;
    monthKwh?: number;
    factor: number;
}
/** What `gas-state.json` keeps across restarts. */
export interface SavedGasState {
    counter: CounterState;
    /** Login backoff, only for the credentials it was recorded with (see `credentialKey`). */
    auth?: AuthState & {
        key: string;
    };
}
/**
 * A short one-way fingerprint of host and credentials, so a saved login
 * backoff is dropped when the owner fixes the password. config.json holds the
 * password in clear anyway; the fingerprint adds nothing an attacker could use.
 */
export declare function credentialKey(host: string, username: string, password: string): string;
export interface GasHistoryOptions {
    dir: string;
    timeZone: string;
    retentionDays: number;
    factors: GasFactors;
    now: () => number;
    onWarn: (message: string) => void;
}
/**
 * The gas meter's history: 5 minute rows (mean and max m³/h, m³) and daily m³
 * in a BucketStore with files of their own (`gas-live-*`, `gas-days-*`), plus
 * the saved counter baseline (`gas-state.json`). kWh are never stored; they
 * are computed from m³ and the factor of each day when read.
 */
export declare class GasHistory implements GasHistoryView {
    private readonly opts;
    readonly store: BucketStore;
    private readonly pastDays;
    private pastFor;
    constructor(opts: GasHistoryOptions);
    private get stateFile();
    /** The saved counter baseline (none: the first sample only sets it) and login backoff. */
    loadState(): Promise<SavedGasState>;
    /** Writes are queued: the poll and a login failure may save at the same time. */
    private stateWrite;
    saveState(state: SavedGasState): Promise<void>;
    record(tMs: number, flowM3h: number | undefined, deltaM3: number): void;
    /** m³ per local day in `[from, to]`. Days before today are cached for the day. */
    days(from: string, to: string): Promise<Map<string, number>>;
    /** Rows `[t, avgM3h, maxM3h, m3]` of a local day (includes the open bucket). */
    liveRows(day: string): Promise<Row[]>;
    rows(day: string): Promise<Array<[number, number]>>;
    /**
     * Today, yesterday and this month. A day is known when it has consumption or
     * recorded rows; the month counts its days with consumption plus today.
     */
    summary(): Promise<GasSummary>;
    flush(all?: boolean): Promise<void>;
    prune(nowMs: number): Promise<void>;
}

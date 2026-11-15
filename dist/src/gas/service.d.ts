import type { PrefixedLogger } from '../util/logger.js';
import { type GasCcuReader } from './ccuReader.js';
import type { GasSettings } from './config.js';
import { type CounterLimits } from './counter.js';
import { type DatapointCheck } from './datapoints.js';
import type { CharValues } from './definitions.js';
import { GasFactors } from './factors.js';
import { GasHistory } from './history.js';
/** The meter cannot pass more than this per hour; larger steps are dropped and re-based. */
export declare const GAS_LIMITS: CounterLimits;
/** After this many polls in a row that hold the same or a rising value below the baseline, it becomes the new baseline. */
export declare const GAS_REBASE_AFTER = 10;
export declare const GAS_FLUSH_INTERVAL_MS: number;
/** 5 minute rows are kept this many days. */
export declare const GAS_LIVE_RETENTION_DAYS = 90;
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
export declare class GasService {
    readonly settings: GasSettings;
    private readonly log;
    private readonly deps;
    readonly history: GasHistory;
    readonly factors: GasFactors;
    readonly reader: GasCcuReader;
    readonly reading: GasReading;
    datapoints: DatapointCheck;
    private state;
    /** Consecutive held readings above 0 and below the baseline, and the last of them. */
    private low;
    private auth;
    private readonly now;
    private readonly setTimer;
    private readonly clearTimer;
    private timers;
    private polling;
    private stopped;
    private lastPrune;
    private readonly warned;
    /** Settles after the start-up datapoint check and the first poll. */
    ready: Promise<void>;
    constructor(settings: GasSettings, storageDir: string, log: PrefixedLogger, deps: GasServiceDeps);
    get timeZone(): string;
    private saveState;
    private get channelAddress();
    start(): Promise<void>;
    private fail;
    /** Read the channel's paramset description once and say whether the datapoints exist. */
    private check;
    /** One poll; concurrent calls share it. */
    pollOnce(): Promise<void>;
    /** A channel 0 flag; a datapoint the CCU does not know is undefined (warned once), other errors fail the poll. */
    private flag;
    private poll;
    private recordValues;
    /**
     * A held reading: a 0 waits for the next reading; a drop to 1 m³ or more is
     * a read glitch. If the counter stays at such a lower level (same or rising
     * for GAS_REBASE_AFTER polls, for example a replaced device) it becomes the
     * new baseline, without counting anything.
     */
    private holdLow;
    /** The HomeKit values as of the last poll. */
    values(): Promise<CharValues>;
    private publish;
    /** Persist the counter baseline first, then the buckets: a crash then loses, never doubles, m³. */
    flush(all?: boolean): Promise<void>;
    /**
     * Stop polling, wait for a running poll and persist everything. The shared
     * CCU session is logged out by the CCU client when the plugin stops.
     */
    stop(): Promise<void>;
}

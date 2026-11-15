/** The raw `gas` block of the platform config. */
export interface GasConfigInput {
    enabled?: unknown;
    name?: unknown;
    /** Channel address of the gas sensor: `[<interface>.]<serial>[:<channel>]`. */
    address?: unknown;
    channel?: unknown;
    interface?: unknown;
    datapoints?: {
        counter?: unknown;
        flow?: unknown;
    };
    pollInterval?: unknown;
    timeZone?: unknown;
    calorificValue?: unknown;
    zNumber?: unknown;
    factorPeriods?: unknown;
    meterReadings?: unknown;
    /** `host` or the name of a multi-bridge; default: the Keller bridge if there is one, else `host`. */
    bridge?: unknown;
    api?: {
        bindAddress?: unknown;
        port?: unknown;
    };
}
/** A dated override of the calorific value and Zustandszahl; `from` and `to` are inclusive local days. */
export interface FactorPeriod {
    from: string;
    /** Open ended when absent. */
    to?: string;
    calorificValue: number;
    zNumber: number;
}
/** A reading of the mechanical meter. Without `time` it counts as taken at the end of `date`. */
export interface MeterReading {
    date: string;
    /** Local wall time `HH:MM`. */
    time?: string;
    m3: number;
}
export interface GasApiSettings {
    bindAddress: string;
    port: number;
}
export interface GasSettings {
    /** True only with a valid `gas` block and `gas.enabled`. */
    enabled: boolean;
    name: string;
    /** CCU interface of the device (JSON-RPC `interface`). */
    iface: string;
    /** Device serial, without interface and channel. */
    address: string;
    channel: number;
    counterDatapoint: string;
    flowDatapoint: string;
    pollIntervalMs: number;
    timeZone: string;
    calorificValue: number;
    zNumber: number;
    factorPeriods: FactorPeriod[];
    meterReadings: MeterReading[];
    /** `host`, a multi-bridge name, or undefined for the default placement. */
    bridge?: string;
    /** The LAN API; absent: off. */
    api?: GasApiSettings;
}
export declare const DEFAULT_GAS_NAME = "Gas Meter";
export declare const DEFAULT_INTERFACE = "BidCos-RF";
export declare const DEFAULT_CHANNEL = 1;
export declare const DEFAULT_COUNTER_DATAPOINT = "GAS_ENERGY_COUNTER";
export declare const DEFAULT_FLOW_DATAPOINT = "GAS_POWER";
export declare const DEFAULT_GAS_POLL_S = 60;
export declare const MIN_GAS_POLL_S = 30;
export declare const MAX_GAS_POLL_S = 600;
export declare const DEFAULT_CALORIFIC_VALUE = 11.2;
export declare const MIN_CALORIFIC_VALUE = 8;
export declare const MAX_CALORIFIC_VALUE = 13;
export declare const DEFAULT_Z_NUMBER = 0.95;
export declare const MIN_Z_NUMBER = 0.8;
export declare const MAX_Z_NUMBER = 1;
export declare const MAX_FACTOR_PERIODS = 100;
export declare const MAX_METER_READINGS = 200;
export declare const MAX_METER_M3 = 1000000000;
export declare const DEFAULT_GAS_API_PORT = 8766;
export declare const HOST_PLACEMENT = "host";
/** True for a `YYYY-MM-DD` string that is a real calendar day. */
export declare function isCalendarDay(day: string): boolean;
export declare const GAS_OFF: GasSettings;
/**
 * Validate the optional `gas` block. Never throws; the caller logs `errors`.
 * Without `gas.enabled` nothing is checked. An invalid address turns the gas
 * meter off; an invalid optional value falls back to its default (factors,
 * time zone) or is ignored (periods, readings, API).
 */
export declare function normalizeGasConfig(raw: unknown): {
    config: GasSettings;
    errors: string[];
};
/** True when `serial` (any case, with or without interface and channel) is the gas meter device. */
export declare function isGasDevice(settings: Pick<GasSettings, 'enabled' | 'address'>, channelAddress: string): boolean;

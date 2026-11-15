import { DAY_PATTERN, isValidTimeZone, ymd } from './dates.js';
import { isPrivateAddress } from './net.js';
export const DEFAULT_GAS_NAME = 'Gas Meter';
export const DEFAULT_INTERFACE = 'BidCos-RF';
export const DEFAULT_CHANNEL = 1;
export const DEFAULT_COUNTER_DATAPOINT = 'GAS_ENERGY_COUNTER';
export const DEFAULT_FLOW_DATAPOINT = 'GAS_POWER';
export const DEFAULT_GAS_POLL_S = 60;
export const MIN_GAS_POLL_S = 30;
export const MAX_GAS_POLL_S = 600;
export const DEFAULT_CALORIFIC_VALUE = 11.2;
export const MIN_CALORIFIC_VALUE = 8;
export const MAX_CALORIFIC_VALUE = 13;
export const DEFAULT_Z_NUMBER = 0.95;
export const MIN_Z_NUMBER = 0.8;
export const MAX_Z_NUMBER = 1.0;
export const MAX_FACTOR_PERIODS = 100;
export const MAX_METER_READINGS = 200;
export const MAX_METER_M3 = 1_000_000_000;
export const DEFAULT_GAS_API_PORT = 8766;
export const HOST_PLACEMENT = 'host';
const INTERFACES = ['BidCos-RF', 'HmIP-RF', 'BidCos-Wired', 'VirtualDevices', 'CUxD'];
const SERIAL_PATTERN = /^[A-Za-z0-9]{1,32}$/;
const ADDRESS_PATTERN = /^(?:([A-Za-z][A-Za-z0-9-]{0,31})\.)?([A-Za-z0-9]{1,32})(?::(\d{1,2}))?$/;
const DATAPOINT_PATTERN = /^[A-Z0-9_]{1,64}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const finite = (v) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
/** True for a `YYYY-MM-DD` string that is a real calendar day. */
export function isCalendarDay(day) {
    if (!DAY_PATTERN.test(day))
        return false;
    const [y, m, d] = ymd(day);
    const date = new Date(0);
    // setUTCFullYear, unlike Date.UTC, does not map years 0 to 99 to 1900 to 1999.
    date.setUTCFullYear(y, m - 1, d);
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
/** A number in `[min, max]`, else the default and an error. */
function ranged(v, fallback, min, max, label, errors) {
    if (v === undefined || v === null || v === '')
        return fallback;
    const n = finite(v);
    if (n === undefined || n < min || n > max) {
        errors.push(`${label} must be a number from ${min} to ${max}, using ${fallback}`);
        return fallback;
    }
    return n;
}
function datapoint(v, fallback, label, errors) {
    const s = str(v);
    if (s === '')
        return fallback;
    if (!DATAPOINT_PATTERN.test(s)) {
        errors.push(`${label} must be a datapoint name (A-Z, 0-9, _), using ${fallback}`);
        return fallback;
    }
    return s;
}
/** One factor period, or an error. Missing values fall back to the defaults. */
function factorPeriod(raw, label, defaults, errors) {
    if (!isObject(raw)) {
        errors.push(`${label}: not an object, ignored`);
        return undefined;
    }
    const from = str(raw.from);
    const to = str(raw.to);
    if (!isCalendarDay(from) || (to !== '' && !isCalendarDay(to)) || (to !== '' && to < from)) {
        errors.push(`${label}: 'from' and optional 'to' must be YYYY-MM-DD days in order, ignored`);
        return undefined;
    }
    const cv = raw.calorificValue;
    const z = raw.zNumber;
    if ((cv === undefined || cv === null) && (z === undefined || z === null)) {
        errors.push(`${label}: needs 'calorificValue' and/or 'zNumber', ignored`);
        return undefined;
    }
    const local = [];
    const calorificValue = ranged(cv, defaults.calorificValue, MIN_CALORIFIC_VALUE, MAX_CALORIFIC_VALUE, `${label}.calorificValue`, local);
    const zNumber = ranged(z, defaults.zNumber, MIN_Z_NUMBER, MAX_Z_NUMBER, `${label}.zNumber`, local);
    if (local.length > 0) {
        errors.push(`${label}: calorificValue ${MIN_CALORIFIC_VALUE} to ${MAX_CALORIFIC_VALUE}, zNumber ${MIN_Z_NUMBER} to ${MAX_Z_NUMBER}, ignored`);
        return undefined;
    }
    return { from, ...(to !== '' ? { to } : {}), calorificValue, zNumber };
}
/** Valid, non-overlapping factor periods sorted by start; an overlapping entry is ignored. */
function factorPeriods(raw, defaults, errors) {
    if (raw === undefined || raw === null)
        return [];
    if (!Array.isArray(raw)) {
        errors.push('gas.factorPeriods must be a list, ignored');
        return [];
    }
    const out = [];
    raw.slice(0, MAX_FACTOR_PERIODS).forEach((entry, i) => {
        const label = `gas.factorPeriods[${i}]`;
        const p = factorPeriod(entry, label, defaults, errors);
        if (!p)
            return;
        const end = p.to ?? '9999-12-31';
        const clash = out.find((o) => p.from <= (o.to ?? '9999-12-31') && o.from <= end);
        if (clash) {
            errors.push(`${label}: overlaps the period from ${clash.from}, ignored`);
            return;
        }
        out.push(p);
    });
    if (raw.length > MAX_FACTOR_PERIODS) {
        errors.push(`gas.factorPeriods: only the first ${MAX_FACTOR_PERIODS} entries are used`);
    }
    return out.sort((a, b) => a.from.localeCompare(b.from));
}
/** Valid meter readings sorted by time; a second reading at the same date and time is ignored. */
function meterReadings(raw, errors) {
    if (raw === undefined || raw === null)
        return [];
    if (!Array.isArray(raw)) {
        errors.push('gas.meterReadings must be a list, ignored');
        return [];
    }
    const out = [];
    raw.slice(0, MAX_METER_READINGS).forEach((entry, i) => {
        const label = `gas.meterReadings[${i}]`;
        if (!isObject(entry)) {
            errors.push(`${label}: not an object, ignored`);
            return;
        }
        const date = str(entry.date);
        const time = str(entry.time);
        const m3 = finite(entry.m3);
        if (!isCalendarDay(date) || (time !== '' && !TIME_PATTERN.test(time))) {
            errors.push(`${label}: 'date' must be YYYY-MM-DD and 'time' HH:MM, ignored`);
            return;
        }
        if (m3 === undefined || m3 < 0 || m3 > MAX_METER_M3) {
            errors.push(`${label}: 'm3' must be a number from 0 to ${MAX_METER_M3}, ignored`);
            return;
        }
        if (out.some((r) => r.date === date && (r.time ?? '') === time)) {
            errors.push(`${label}: a reading for ${date} ${time || '(end of day)'} exists, ignored`);
            return;
        }
        out.push({ date, ...(time !== '' ? { time } : {}), m3 });
    });
    if (raw.length > MAX_METER_READINGS) {
        errors.push(`gas.meterReadings: only the first ${MAX_METER_READINGS} entries are used`);
    }
    // Without a time a reading counts as taken at the end of its day.
    const key = (r) => `${r.date} ${r.time ?? '24:00'}`;
    return out.sort((a, b) => key(a).localeCompare(key(b)));
}
const hostTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export const GAS_OFF = {
    enabled: false,
    name: DEFAULT_GAS_NAME,
    iface: DEFAULT_INTERFACE,
    address: '',
    channel: DEFAULT_CHANNEL,
    counterDatapoint: DEFAULT_COUNTER_DATAPOINT,
    flowDatapoint: DEFAULT_FLOW_DATAPOINT,
    pollIntervalMs: DEFAULT_GAS_POLL_S * 1000,
    timeZone: 'UTC',
    calorificValue: DEFAULT_CALORIFIC_VALUE,
    zNumber: DEFAULT_Z_NUMBER,
    factorPeriods: [],
    meterReadings: [],
};
/** Device serial, interface and channel from `gas.address`, `gas.interface` and `gas.channel`. */
function deviceOf(g, fatal) {
    const m = ADDRESS_PATTERN.exec(str(g.address));
    const prefix = m?.[1];
    const serial = m?.[2] ?? '';
    if (!m || !SERIAL_PATTERN.test(serial) || (prefix !== undefined && !INTERFACES.includes(prefix))) {
        fatal.push('gas.address must be the channel address of the gas sensor, [<interface>.]<serial>:<channel>');
    }
    const ifaceRaw = str(g.interface);
    if (ifaceRaw !== '' && !INTERFACES.includes(ifaceRaw)) {
        fatal.push(`gas.interface must be one of ${INTERFACES.join(', ')}`);
    }
    if (prefix !== undefined && ifaceRaw !== '' && prefix !== ifaceRaw) {
        fatal.push('gas.interface does not match the interface in gas.address');
    }
    let channel = m?.[3] !== undefined ? Number(m[3]) : DEFAULT_CHANNEL;
    const channelRaw = g.channel;
    if (channelRaw !== undefined && channelRaw !== null && channelRaw !== '') {
        const n = finite(channelRaw);
        if (n === undefined || !Number.isInteger(n) || n < 1 || n > 50) {
            fatal.push('gas.channel must be a channel number from 1 to 50');
        }
        else if (m?.[3] !== undefined && n !== channel) {
            fatal.push('gas.channel does not match the channel in gas.address');
        }
        else {
            channel = n;
        }
    }
    if (channel < 1 || channel > 50)
        fatal.push('the channel in gas.address must be from 1 to 50');
    return { iface: prefix ?? (ifaceRaw || DEFAULT_INTERFACE), address: serial, channel };
}
/** The optional LAN API: a literal private or loopback bind address and a port. */
function apiOf(raw, errors) {
    if (raw === undefined || raw === null)
        return undefined;
    if (!isObject(raw)) {
        errors.push('gas.api must be an object; the gas API is off');
        return undefined;
    }
    const bindAddress = str(raw.bindAddress);
    if (bindAddress === '')
        return undefined;
    if (!isPrivateAddress(bindAddress)) {
        errors.push('gas.api.bindAddress must be a literal private or loopback IP address (not 0.0.0.0, not a host name); the gas API is off');
        return undefined;
    }
    let port = DEFAULT_GAS_API_PORT;
    if (raw.port !== undefined && raw.port !== null && raw.port !== '') {
        const n = finite(raw.port);
        if (n === undefined || !Number.isInteger(n) || n < 1024 || n > 65535) {
            errors.push('gas.api.port must be a port number from 1024 to 65535; the gas API is off');
            return undefined;
        }
        port = n;
    }
    return { bindAddress, port };
}
/**
 * Validate the optional `gas` block. Never throws; the caller logs `errors`.
 * Without `gas.enabled` nothing is checked. An invalid address turns the gas
 * meter off; an invalid optional value falls back to its default (factors,
 * time zone) or is ignored (periods, readings, API).
 */
export function normalizeGasConfig(raw) {
    const errors = [];
    const g = isObject(raw) ? raw : {};
    if (g.enabled !== true)
        return { config: GAS_OFF, errors };
    const fatal = [];
    const device = deviceOf(g, fatal);
    if (fatal.length > 0) {
        return { config: GAS_OFF, errors: fatal.map((e) => `${e}; the gas meter is off`) };
    }
    const dp = isObject(g.datapoints) ? g.datapoints : {};
    const counterDatapoint = datapoint(dp.counter, DEFAULT_COUNTER_DATAPOINT, 'gas.datapoints.counter', errors);
    const flowDatapoint = datapoint(dp.flow, DEFAULT_FLOW_DATAPOINT, 'gas.datapoints.flow', errors);
    const interval = finite(g.pollInterval) ?? DEFAULT_GAS_POLL_S;
    const calorificValue = ranged(g.calorificValue, DEFAULT_CALORIFIC_VALUE, MIN_CALORIFIC_VALUE, MAX_CALORIFIC_VALUE, 'gas.calorificValue', errors);
    const zNumber = ranged(g.zNumber, DEFAULT_Z_NUMBER, MIN_Z_NUMBER, MAX_Z_NUMBER, 'gas.zNumber', errors);
    let timeZone = str(g.timeZone);
    if (timeZone !== '' && !isValidTimeZone(timeZone)) {
        errors.push('gas.timeZone is not a valid IANA time zone, using the time zone of this host');
        timeZone = '';
    }
    const bridgeRaw = str(g.bridge);
    const api = apiOf(g.api, errors);
    return {
        config: {
            enabled: true,
            name: str(g.name).slice(0, 64) || DEFAULT_GAS_NAME,
            ...device,
            counterDatapoint,
            flowDatapoint,
            pollIntervalMs: Math.round(Math.min(MAX_GAS_POLL_S, Math.max(MIN_GAS_POLL_S, interval))) * 1000,
            timeZone: timeZone || hostTimeZone(),
            calorificValue,
            zNumber,
            factorPeriods: factorPeriods(g.factorPeriods, { calorificValue, zNumber }, errors),
            meterReadings: meterReadings(g.meterReadings, errors),
            ...(bridgeRaw !== '' ? { bridge: bridgeRaw.slice(0, 64) } : {}),
            ...(api ? { api } : {}),
        },
        errors,
    };
}
/** True when `serial` (any case, with or without interface and channel) is the gas meter device. */
export function isGasDevice(settings, channelAddress) {
    if (!settings.enabled || settings.address === '')
        return false;
    const m = ADDRESS_PATTERN.exec(channelAddress.trim());
    return m?.[2]?.toUpperCase() === settings.address.toUpperCase();
}
//# sourceMappingURL=config.js.map
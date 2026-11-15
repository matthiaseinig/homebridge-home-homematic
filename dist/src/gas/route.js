import { dayKey, MONTH_PATTERN } from './dates.js';
import { isCalendarDay } from './config.js';
import { displayedReading, readingDrift } from './readings.js';
/** Page size of /v1/gas/days. */
export const MAX_GAS_DAYS = 3700;
const iso = (ms) => ms === undefined ? null : new Date(ms).toISOString();
const bad = (error) => ({ status: 400, body: { error } });
/** `from`/`to` of a request: defaults when absent, undefined when invalid or out of order. */
function range(q, valid, min, max) {
    const from = q.get('from') ?? min;
    const to = q.get('to') ?? max;
    if (!valid(from) || !valid(to) || from > to)
        return undefined;
    return { from, to };
}
const isMonth = (s) => MONTH_PATTERN.test(s) && Number(s.slice(5)) >= 1 && Number(s.slice(5)) <= 12;
const isYear = (s) => /^\d{4}$/.test(s);
/** `/v1/gas/status`: never carries the host, the device address, credentials or the session id. */
export async function gasStatus(gas, nowMs) {
    const r = gas.reading;
    const s = gas.settings;
    const today = dayKey(nowMs, gas.timeZone);
    const shown = await displayedReading(gas.history, s.meterReadings, nowMs, gas.timeZone);
    const deviceOk = r.ccuOk && r.reachable !== false;
    const counter = deviceOk ? r.counterM3 : undefined;
    const factor = gas.factors.forDay(today);
    const retryAt = gas.reader.retryAt;
    return {
        schema: 1,
        reachable: r.ccuOk ? (r.reachable ?? null) : null,
        lowBattery: r.ccuOk ? (r.lowBattery ?? null) : null,
        lastUpdate: iso(r.lastUpdate),
        flowM3h: deviceOk ? (r.flowM3h ?? null) : null,
        counterM3: counter ?? null,
        meterReadingM3: counter === undefined ? null : (shown?.m3 ?? counter),
        meterReadingSource: shown ? 'reading' : 'device',
        reading: shown
            ? { date: shown.reading.date, time: shown.reading.time ?? null, m3: shown.reading.m3 }
            : null,
        drift: await readingDrift(gas.history, s.meterReadings, nowMs, gas.timeZone),
        factor: { date: today, ...factor },
        datapoints: {
            counter: s.counterDatapoint,
            flow: s.flowDatapoint,
            checked: gas.datapoints.checked,
            found: gas.datapoints.found ?? null,
            units: gas.datapoints.units ?? null,
        },
        pollIntervalSeconds: s.pollIntervalMs / 1000,
        intervalSeconds: 300,
        ccu: {
            session: gas.reader.hasSession,
            lastError: r.lastError ?? null,
            retryAt: iso(retryAt),
        },
        units: {
            flow: 'm³/h',
            volume: 'm³',
            energy: 'kWh',
            factor: 'kWh/m³',
            live: 'mean and max m³/h, m³ per 5 minute bucket',
        },
    };
}
/** The `/v1/gas/*` routes. GET and the token are checked by the server before this runs. */
export async function handleGas(gas, url, nowMs) {
    const q = url.searchParams;
    switch (url.pathname) {
        case '/v1/gas/status':
            return { status: 200, body: await gasStatus(gas, nowMs) };
        case '/v1/gas/live': {
            const date = q.get('date') ?? '';
            if (!isCalendarDay(date))
                return bad('date must be a YYYY-MM-DD day');
            const rows = await gas.history.liveRows(date);
            return {
                status: 200,
                body: {
                    date,
                    intervalSeconds: 300,
                    factor: gas.factors.forDay(date).kwhPerM3,
                    columns: ['t', 'avgM3h', 'maxM3h', 'm3'],
                    rows,
                },
            };
        }
        case '/v1/gas/days': {
            const r = range(q, isCalendarDay, '0001-01-01', '9999-12-31');
            if (!r)
                return bad('from and to must be YYYY-MM-DD days, from not after to');
            const all = [...(await gas.history.days(r.from, r.to))]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([d, m3]) => gas.factors.day(d, m3));
            const next = all[MAX_GAS_DAYS]?.period ?? null;
            return { status: 200, body: { days: all.slice(0, MAX_GAS_DAYS), next } };
        }
        case '/v1/gas/months': {
            const r = range(q, isMonth, '0001-01', '9999-12');
            if (!r)
                return bad('from and to must be YYYY-MM months, from not after to');
            const days = await gas.history.days(`${r.from}-01`, `${r.to}-31`);
            const list = [...days].map(([date, m3]) => ({ date, m3 }));
            return { status: 200, body: { months: gas.factors.sum(list, 7) } };
        }
        case '/v1/gas/years': {
            const r = range(q, isYear, '0001', '9999');
            if (!r)
                return bad('from and to must be YYYY years, from not after to');
            const days = await gas.history.days(`${r.from}-01-01`, `${r.to}-12-31`);
            const list = [...days].map(([date, m3]) => ({ date, m3 }));
            return { status: 200, body: { years: gas.factors.sum(list, 4) } };
        }
        default:
            return { status: 404, body: { error: 'not found' } };
    }
}
//# sourceMappingURL=route.js.map
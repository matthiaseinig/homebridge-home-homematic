import { request } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { credentialKey } from '../../../src/gas/history.js';
import { helloProof } from '../../../src/gas/hello.js';
import { handleGas } from '../../../src/gas/route.js';
import { GasApiServer } from '../../../src/gas/server.js';
import { GasService } from '../../../src/gas/service.js';
import {
  ADDRESS,
  cleanup,
  clock,
  fakeCcu,
  gasSettings,
  HOST,
  PASSWORD,
  prefixed,
  reader,
  recordingLog,
  sharedSession,
  tempDir,
  USER,
} from './helpers.js';

cleanup();

const TOKEN = 'Zq3x9KpL2mN8vB4cR7tY1wE6uI0oPaSdFgHjKlXcVbN';
const NOW = Date.UTC(2026, 10, 15, 11, 0, 0); // 12:00 local

async function boot(extra: Record<string, unknown> = {}, token = TOKEN) {
  const dir = await tempDir();
  const ccu = await fakeCcu();
  const t = clock(NOW);
  const log = recordingLog();
  const api = sharedSession(ccu.port, log);
  const gas = new GasService(
    gasSettings({
      factorPeriods: [{ from: '2026-11-01', calorificValue: 10, zNumber: 0.9 }],
      meterReadings: [{ date: '2026-10-30', m3: 5000 }, { date: '2026-11-02', m3: 5012.5 }],
      ...extra,
    }),
    dir,
    prefixed(log),
    { reader: reader(api, t.now), authKey: credentialKey(HOST, USER, PASSWORD), now: t.now, setTimer: () => 0, clearTimer: () => undefined },
  );
  // history: 2026-10-31 3 m³, 2026-11-01 6 m³, 2026-11-02 4 m³, today 0.5 m³
  gas.history.record(Date.UTC(2026, 9, 31, 9), 1, 3);
  gas.history.record(Date.UTC(2026, 10, 1, 9), 1, 6);
  gas.history.record(Date.UTC(2026, 10, 2, 9), 1, 4);
  gas.history.record(Date.UTC(2025, 5, 1, 9), 1, 7);
  await gas.history.flush(true);
  ccu.values = { GAS_ENERGY_COUNTER: '321.5', GAS_POWER: '0.8' };
  await gas.start();
  await gas.ready;
  gas.history.record(NOW - 60_000, 0.8, 0.5);
  const warnings: string[] = [];
  const server = new GasApiServer({
    bindAddress: '127.0.0.1',
    port: 0,
    token,
    handle: (url, nowMs) => handleGas(gas, url, nowMs),
    warn: (m) => warnings.push(m),
    now: t.now,
  });
  const port = await server.start();
  const get = (path: string, auth = true) =>
    fetch(`http://127.0.0.1:${port}${path}`, { headers: auth ? { Authorization: `Bearer ${token}` } : {} });
  const stop = async () => {
    await server.stop();
    await gas.stop();
    await api.logout();
  };
  return { get, stop, ccu, gas, dir, port, warnings, log };
}

/** A raw request with a chosen Host header and method (fetch does not allow a foreign Host). */
function raw(port: number, path: string, headers: Record<string, string>, method = 'GET'): Promise<{ status: number; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('gas API server', () => {
  it('needs the token, GET and the bound Host; serves only /v1/gas and /v1/hello', async () => {
    const { get, stop, port } = await boot();
    try {
      expect((await get('/v1/gas/status', false)).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${port}/v1/gas/status`, { headers: { Authorization: `Bearer ${TOKEN}x` } })).status).toBe(401);
      expect((await get('/v1/gas/nope')).status).toBe(404);
      expect((await get('/v1/status')).status).toBe(404);
      const auth = { Authorization: `Bearer ${TOKEN}` };
      expect((await raw(port, '/v1/gas/status', { ...auth, Host: `evil.example:${port}` })).status).toBe(421);
      expect((await raw(port, '/v1/gas/status', { ...auth, Host: `127.0.0.1:${port}` }, 'POST')).status).toBe(405);
    } finally {
      await stop();
    }
  });

  it('answers /v1/hello with the HMAC proof without a token, and refuses bad nonces', async () => {
    const { get, stop, port } = await boot();
    try {
      const nonce = 'A'.repeat(20) + 'b'.repeat(23);
      const res = await get(`/v1/hello?nonce=${nonce}`, false);
      expect(res.status).toBe(204);
      expect(res.headers.get('x-home-proof')).toBe(helloProof(TOKEN, nonce, `127.0.0.1:${port}`));
      expect((await get('/v1/hello?nonce=short', false)).status).toBe(400);
      expect((await raw(port, `/v1/hello?nonce=${nonce}`, { Host: `127.0.0.1:${port}` }, 'POST')).status).toBe(405);
    } finally {
      await stop();
    }
  });

  it('turns /v1/hello off for a weak token and says so', async () => {
    const { get, stop, warnings } = await boot({}, 'short-token');
    try {
      expect((await get('/v1/hello?nonce=' + 'a'.repeat(43), false)).status).toBe(404);
      expect(warnings[0]).toMatch(/hello is off/);
      expect((await get('/v1/gas/status')).status).toBe(200);
    } finally {
      await stop();
    }
  });

  it('refuses a public bind address or a missing token', () => {
    const handle = async () => ({ status: 200, body: {} });
    expect(() => new GasApiServer({ bindAddress: '0.0.0.0', port: 0, token: TOKEN, handle })).toThrow(/private/);
    expect(() => new GasApiServer({ bindAddress: '127.0.0.1', port: 0, token: '', handle })).toThrow(/token/);
  });

  it('answers 500 without details when a route fails', async () => {
    const server = new GasApiServer({ bindAddress: '127.0.0.1', port: 0, token: TOKEN, handle: async () => { throw new Error(`boom ${ADDRESS}`); } });
    const port = await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/gas/status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain(ADDRESS);
    } finally {
      await server.stop();
      await server.stop();
    }
  });
});

describe('/v1/gas', () => {
  it('serves the status without host, address, credentials or session id', async () => {
    const { get, stop } = await boot();
    try {
      const res = await get('/v1/gas/status');
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const secret of [PASSWORD, USER, ADDRESS, HOST, 'sid1x']) expect(text).not.toContain(secret);
      expect(JSON.parse(text)).toMatchObject({
        schema: 1,
        reachable: true,
        lowBattery: false,
        lastUpdate: new Date(NOW).toISOString(),
        flowM3h: 0.8,
        counterM3: 321.5,
        meterReadingM3: 5013,
        meterReadingSource: 'reading',
        reading: { date: '2026-11-02', time: null, m3: 5012.5 },
        drift: [{ date: '2026-11-02', time: null, m3: 5012.5, expectedM3: 5013, driftM3: -0.5, exact: true }],
        factor: { date: '2026-11-15', kwhPerM3: 9, calorificValue: 10, zNumber: 0.9, source: 'period' },
        datapoints: { counter: 'GAS_ENERGY_COUNTER', flow: 'GAS_POWER', checked: true, found: true, units: { counter: 'm3', flow: 'm3' } },
        pollIntervalSeconds: 60,
        intervalSeconds: 300,
        ccu: { session: true, lastError: null, retryAt: null },
      });
    } finally {
      await stop();
    }
  });

  it('masks the device address, the CCU host and IPv4 addresses in ccu.lastError (verifier finding 2)', async () => {
    const { get, stop, ccu, gas } = await boot();
    try {
      ccu.handler = (c) => (c.method === 'Interface.getParamset'
        ? { error: { code: 501, message: `Unknown device ${ADDRESS}:1 on ${HOST}, gateway 192.0.2.20` } }
        : undefined);
      await gas.pollOnce();
      const text = await (await get('/v1/gas/status')).text();
      const body = JSON.parse(text);
      expect(body.ccu.lastError).toContain('***');
      for (const s of [ADDRESS, HOST, '192.0.2.20']) expect(text).not.toContain(s);
    } finally {
      await stop();
    }
  });

  it('reports the backoff in ccu.retryAt while the CCU user lacks the rights', async () => {
    const { get, stop, ccu, gas } = await boot();
    try {
      ccu.noRights = true;
      await gas.pollOnce();
      const body = await (await get('/v1/gas/status')).json();
      expect(body.ccu.retryAt).toBe(new Date(NOW + 60_000).toISOString());
      expect(body.ccu.lastError).toMatch(/rights/);
      expect(body.reachable).toBeNull();
    } finally {
      await stop();
    }
  });

  it('shows the device counter as the meter reading without readings, and nulls while unreachable', async () => {
    const { get, stop, ccu, gas } = await boot({ meterReadings: [] });
    try {
      expect(await (await get('/v1/gas/status')).json()).toMatchObject({
        meterReadingM3: 321.5, meterReadingSource: 'device', reading: null, drift: [],
      });
      ccu.unreach = true;
      await gas.pollOnce();
      expect(await (await get('/v1/gas/status')).json()).toMatchObject({
        reachable: false, flowM3h: null, counterM3: null, meterReadingM3: null,
      });
    } finally {
      await stop();
    }
  });

  it('serves days, months and years with m³, kWh and the factor of each day', async () => {
    const { get, stop } = await boot();
    try {
      expect(await (await get('/v1/gas/days?from=2026-10-31&to=2026-11-30')).json()).toEqual({
        days: [
          { period: '2026-10-31', m3: 3, kwh: 31.92, factor: 10.64 },
          { period: '2026-11-01', m3: 6, kwh: 54, factor: 9 },
          { period: '2026-11-02', m3: 4, kwh: 36, factor: 9 },
          { period: '2026-11-15', m3: 0.5, kwh: 4.5, factor: 9 },
        ],
        next: null,
      });
      expect((await (await get('/v1/gas/months?from=2026-10&to=2026-11')).json()).months).toEqual([
        { period: '2026-10', m3: 3, kwh: 31.92, factor: 10.64, factors: [10.64] },
        { period: '2026-11', m3: 10.5, kwh: 94.5, factor: 9, factors: [9] },
      ]);
      expect((await (await get('/v1/gas/years')).json()).years).toEqual([
        { period: '2025', m3: 7, kwh: 74.48, factor: 10.64, factors: [10.64] },
        { period: '2026', m3: 13.5, kwh: 126.42, factor: 9.3644, factors: [9, 10.64] },
      ]);
      expect((await (await get('/v1/gas/days')).json()).days).toHaveLength(5);
    } finally {
      await stop();
    }
  });

  it('serves the 5 minute rows of a local day', async () => {
    const { get, stop } = await boot();
    try {
      const body = await (await get('/v1/gas/live?date=2026-11-15')).json();
      expect(body).toMatchObject({ date: '2026-11-15', intervalSeconds: 300, factor: 9, columns: ['t', 'avgM3h', 'maxM3h', 'm3'] });
      expect(body.rows.find((r: number[]) => r[0] === (NOW - 300_000) / 1000)).toEqual([(NOW - 300_000) / 1000, 0.8, 0.8, 0.5]);
      expect((await (await get('/v1/gas/live?date=2026-01-01')).json()).rows).toEqual([]);
    } finally {
      await stop();
    }
  });

  it('rejects bad parameters with 400', async () => {
    const { get, stop } = await boot();
    try {
      for (const path of [
        '/v1/gas/live',
        '/v1/gas/live?date=2026-02-30',
        '/v1/gas/days?from=2026-11-31',
        '/v1/gas/days?from=2026-11-10&to=2026-11-01',
        '/v1/gas/months?from=2026-13',
        '/v1/gas/months?from=2026-11&to=2026-10',
        '/v1/gas/years?from=26',
        '/v1/gas/years?from=2027&to=2026',
      ]) {
        const res = await get(path);
        expect(res.status, path).toBe(400);
        expect((await res.json()).error).toBeTypeOf('string');
      }
    } finally {
      await stop();
    }
  });

  it('pages long day lists', async () => {
    const { get, stop, dir } = await boot();
    try {
      const months = new Map<string, Record<string, Record<string, number>>>();
      for (let i = 0; i < 3705; i++) {
        const day = new Date(Date.UTC(2010, 0, 1 + i)).toISOString().slice(0, 10);
        const m = months.get(day.slice(0, 7)) ?? {};
        m[day] = { 'gas|m3': 0.01 };
        months.set(day.slice(0, 7), m);
      }
      for (const [month, days] of months) {
        await writeFile(join(dir, `gas-days-${month}.json`), JSON.stringify({ version: 1, month, days }));
      }
      const first = await (await get('/v1/gas/days?from=2010-01-01&to=2020-12-31')).json();
      expect(first.days).toHaveLength(3700);
      expect(first.next).toBe('2020-02-18');
      const rest = await (await get(`/v1/gas/days?from=${first.next}&to=2020-12-31`)).json();
      expect(rest).toMatchObject({ next: null });
      expect(rest.days).toHaveLength(5);
    } finally {
      await stop();
    }
  });
});

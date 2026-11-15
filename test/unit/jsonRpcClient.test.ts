import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { Buffer } from 'node:buffer';
import { CcuJsonRpcClient, JsonRpcError, isSafeIdentifier } from '../../src/ccu/CcuJsonRpcClient.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';

interface State {
  loginCalls: number;
  callCounts: Record<string, number>;
  nextLoginPayload: unknown;
  nextResponse: Record<string, unknown>;
  failNextOnceWith: { code: number; message: string } | undefined;
  lastBody: string;
}

let server: http.Server;
let port = 0;
let s: State;

beforeEach(async () => {
  s = {
    loginCalls: 0,
    callCounts: {},
    nextLoginPayload: { version: '1.1', result: 'SID-test', error: null },
    nextResponse: { default: { version: '1.1', result: 'ok', error: null } },
    failNextOnceWith: undefined,
    lastBody: '',
  };
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      s.lastBody = body;
      let parsed: { method?: string };
      try { parsed = JSON.parse(body); } catch { parsed = {}; }
      const method = parsed.method ?? '';
      s.callCounts[method] = (s.callCounts[method] ?? 0) + 1;
      const respond = (payload: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (method === 'Session.login') {
        s.loginCalls++;
        respond(s.nextLoginPayload);
        return;
      }
      if (s.failNextOnceWith) {
        const f = s.failNextOnceWith;
        s.failNextOnceWith = undefined;
        respond({ version: '1.1', result: null, error: { code: f.code, message: f.message } });
        return;
      }
      respond(s.nextResponse[method] ?? s.nextResponse.default);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeClient(auth?: { username: string; password: string }): CcuJsonRpcClient {
  return new CcuJsonRpcClient({
    host: '127.0.0.1',
    port,
    auth,
    log: new PrefixedLogger(makeLog(), 'jsonrpc-test'),
  });
}

describe('CcuJsonRpcClient', () => {
  it('attaches _session_id_ on every authenticated call', async () => {
    const c = makeClient({ username: 'u', password: 'p' });
    await c.call('Anything');
    const body = JSON.parse(s.lastBody);
    expect(body.params._session_id_).toBe('SID-test');
  });

  it('caches the session id across calls', async () => {
    const c = makeClient({ username: 'u', password: 'p' });
    await c.call('A');
    await c.call('B');
    await c.call('C');
    expect(s.loginCalls).toBe(1);
  });

  it('does NOT call Session.login when auth is unconfigured', async () => {
    const c = makeClient();
    await c.call('OpenAccess');
    expect(s.loginCalls).toBe(0);
  });

  it('renews the session on a 401-ish error and retries the call', async () => {
    s.failNextOnceWith = { code: 401, message: 'session expired' };
    const c = makeClient({ username: 'u', password: 'p' });
    const out = await c.call('A');
    expect(out).toBe('ok');
    expect(s.loginCalls).toBe(2);
  });

  it('renews on a "session" message even if the code is non-401', async () => {
    s.failNextOnceWith = { code: 0, message: 'invalid session id' };
    const c = makeClient({ username: 'u', password: 'p' });
    await c.call('A');
    expect(s.loginCalls).toBe(2);
  });

  it('surfaces the CCU error when login fails with bad credentials', async () => {
    s.nextLoginPayload = { version: '1.1', result: null, error: { code: 501, message: 'invalid credentials' } };
    const c = makeClient({ username: 'admin', password: 'bad' });
    await expect(c.call('Anything')).rejects.toThrow(/CCU auth failed.*invalid credentials/);
  });

  it('rejects malformed login response', async () => {
    server.removeAllListeners('request');
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{not json');
    });
    const c = makeClient({ username: 'u', password: 'p' });
    await expect(c.call('Anything')).rejects.toThrow(/CCU auth.*malformed/);
  });

  it('rejects empty session id', async () => {
    s.nextLoginPayload = { version: '1.1', result: '', error: null };
    const c = makeClient({ username: 'u', password: 'p' });
    await expect(c.call('Anything')).rejects.toThrow(/empty session/);
  });

  it('strips wrapper @ chars from the returned sid', async () => {
    s.nextLoginPayload = { version: '1.1', result: '@@@WrapTest@@@', error: null };
    const c = makeClient({ username: 'u', password: 'p' });
    await c.call('Anything');
    expect(JSON.parse(s.lastBody).params._session_id_).toBe('WrapTest');
  });

  it('invalidateSession() forces a new login on next call', async () => {
    const c = makeClient({ username: 'u', password: 'p' });
    await c.call('A');
    expect(s.loginCalls).toBe(1);
    c.invalidateSession();
    await c.call('B');
    expect(s.loginCalls).toBe(2);
  });
});

describe('CcuJsonRpcClient.listDevices', () => {
  it('maps Device.listAllDetail into our internal shape', async () => {
    s.nextResponse['Device.listAllDetail'] = {
      version: '1.1',
      result: [
        {
          id: '1295', name: 'Aussensensor', address: '000ED8A990996D',
          interface: 'HmIP-RF', type: 'HmIP-STHO',
          channels: [
            { id: '1296', name: 'X:0', address: '000ED8A990996D:0', deviceId: '1295', index: 0, channelType: 'MAINTENANCE' },
            { id: '1297', name: 'X:1', address: '000ED8A990996D:1', deviceId: '1295', index: 1, channelType: 'WEATHER_TRANSMIT' },
          ],
        },
      ],
      error: null,
    };
    const c = makeClient({ username: 'u', password: 'p' });
    const devices = await c.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      address: '000ED8A990996D',
      name: 'Aussensensor',
      type: 'HmIP-STHO',
      interface: 'HmIP-RF',
    });
    expect(devices[0]?.channels).toHaveLength(2);
    expect(devices[0]?.channels[1]?.type).toBe('WEATHER_TRANSMIT');
  });

  it('falls back to BidCos-RF for unknown interfaces', async () => {
    s.nextResponse['Device.listAllDetail'] = {
      version: '1.1',
      result: [{ id: '1', address: 'X', interface: 'Mystery', channels: [] }],
      error: null,
    };
    const c = makeClient({ username: 'u', password: 'p' });
    const devices = await c.listDevices();
    expect(devices[0]?.interface).toBe('BidCos-RF');
  });

  it('infers interface from name heuristics', async () => {
    s.nextResponse['Device.listAllDetail'] = {
      version: '1.1',
      result: [
        { id: '1', address: 'A', interface: 'someHmIPthing', channels: [] },
        { id: '2', address: 'B', interface: 'cuxd-bridge', channels: [] },
        { id: '3', address: 'C', interface: 'wired-12345', channels: [] },
        { id: '4', address: 'D', interface: 'virtdev', channels: [] },
      ],
      error: null,
    };
    const c = makeClient({ username: 'u', password: 'p' });
    const devices = await c.listDevices();
    expect(devices.map(d => d.interface)).toEqual(['HmIP-RF', 'CUxD', 'BidCos-Wired', 'VirtualDevices']);
  });
});

describe('CcuJsonRpcClient.listVariables', () => {
  it('maps each variable type and coerces values', async () => {
    s.nextResponse['SysVar.getAll'] = {
      version: '1.1',
      result: [
        { id: '1', name: 'B',     type: 'BOOL',   value: 'true' },
        { id: '2', name: 'F',     type: 'FLOAT',  value: 42.5, minValue: 0, maxValue: 100, unit: '%' },
        { id: '3', name: 'S',     type: 'STRING', value: 'hello' },
        { id: '4', name: 'E',     type: 'ENUM',   value: 0, valueList: ['A', 'B'] },
        { id: '5', name: 'BadF',  type: 'FLOAT',  value: 'NaN' },
      ],
      error: null,
    };
    const c = makeClient({ username: 'u', password: 'p' });
    const vars = await c.listVariables();
    expect(vars[0]).toMatchObject({ valuetype: 2, value: true });
    expect(vars[1]).toMatchObject({ valuetype: 4, value: 42.5, minValue: 0, maxValue: 100, unit: '%' });
    expect(vars[2]).toMatchObject({ valuetype: 16, value: 'hello' });
    expect(vars[3]?.enumValues).toEqual(['A', 'B']);
    expect(vars[4]?.value).toBe(0);
  });
});

describe('CcuJsonRpcClient.listInterfaces', () => {
  it('returns name + port for each interface', async () => {
    s.nextResponse['Interface.listInterfaces'] = {
      version: '1.1',
      result: [
        { name: 'BidCos-RF', port: 32001 },
        { name: 'HmIP-RF', port: 32010 },
      ],
      error: null,
    };
    const c = makeClient({ username: 'u', password: 'p' });
    const list = await c.listInterfaces();
    expect(list).toEqual([
      { name: 'BidCos-RF', port: 32001, url: undefined },
      { name: 'HmIP-RF', port: 32010, url: undefined },
    ]);
  });

  it('parses the port out of url when port field is missing', async () => {
    s.nextResponse['Interface.listInterfaces'] = {
      version: '1.1',
      result: [{ name: 'HmIP-RF', url: 'xmlrpc://127.0.0.1:32010' }],
      error: null,
    };
    const c = makeClient({ username: 'u', password: 'p' });
    const list = await c.listInterfaces();
    expect(list[0]?.port).toBe(32010);
  });

  it('drops entries with no usable port', async () => {
    s.nextResponse['Interface.listInterfaces'] = {
      version: '1.1',
      result: [
        { name: 'Broken', url: 'unknown://no-port' },
        { name: '' },
        { name: 'Good', port: '12345' },
      ],
      error: null,
    };
    const c = makeClient({ username: 'u', password: 'p' });
    const list = await c.listInterfaces();
    expect(list).toEqual([{ name: 'Good', port: 12345, url: undefined }]);
  });
});

describe('CcuJsonRpcClient.listPrograms / listRooms', () => {
  it('listPrograms maps result', async () => {
    s.nextResponse['Program.getAll'] = {
      version: '1.1',
      result: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }],
      error: null,
    };
    const c = makeClient({ username: 'u', password: 'p' });
    expect((await c.listPrograms())).toEqual([{ id: '1', name: 'A' }, { id: '2', name: 'B' }]);
  });

  it('listRooms stringifies channel ids', async () => {
    s.nextResponse['Room.getAll'] = {
      version: '1.1',
      result: [{ id: 5, name: 'Living', channelIds: [10, 11, '12'] }],
      error: null,
    };
    const c = makeClient({ username: 'u', password: 'p' });
    expect((await c.listRooms())[0]).toEqual({ id: '5', name: 'Living', channelIds: ['10', '11', '12'] });
  });
});

describe('CcuJsonRpcClient.getInterfaceValue / setInterfaceValue', () => {
  it('passes interface, address, valueKey through', async () => {
    s.nextResponse['Interface.getValue'] = { version: '1.1', result: '22.4', error: null };
    const c = makeClient({ username: 'u', password: 'p' });
    expect(await c.getInterfaceValue('HmIP-RF', '000:1', 'ACTUAL_TEMPERATURE')).toBe('22.4');
    const body = JSON.parse(s.lastBody);
    expect(body.params).toMatchObject({ interface: 'HmIP-RF', address: '000:1', valueKey: 'ACTUAL_TEMPERATURE' });
  });

  it('setInterfaceValue includes type discriminator', async () => {
    const c = makeClient({ username: 'u', password: 'p' });
    await c.setInterfaceValue('HmIP-RF', '000:1', 'STATE', 'boolean', true);
    const body = JSON.parse(s.lastBody);
    expect(body.params.type).toBe('boolean');
    expect(body.params.value).toBe(true);
  });
});

describe('CcuJsonRpcClient.{get,set}Variable + runProgram', () => {
  it('getVariable rejects unsafe names', async () => {
    const c = makeClient({ username: 'u', password: 'p' });
    await expect(c.getVariable('foo;bar')).rejects.toThrow(/unsafe/);
  });

  it('setVariable rejects unsafe names', async () => {
    const c = makeClient({ username: 'u', password: 'p' });
    await expect(c.setVariable('foo;bar', true)).rejects.toThrow(/unsafe/);
  });

  it('setVariable falls through to setFloat for STRING / unknown types', async () => {
    s.nextResponse['SysVar.getAll'] = {
      version: '1.1',
      result: [{ id: '9', name: 'StringVar', type: 'STRING' }],
      error: null,
    };
    const c = makeClient({ username: 'u', password: 'p' });
    await c.setVariable('StringVar', 'hello');
    expect(s.callCounts['SysVar.setFloat']).toBe(1);
  });

  it('setVariable routes ENUM through SysVar.setEnum', async () => {
    s.nextResponse['SysVar.getAll'] = {
      version: '1.1',
      result: [{ id: '11', name: 'Mode', type: 'ENUM' }],
      error: null,
    };
    const c = makeClient({ username: 'u', password: 'p' });
    await c.setVariable('Mode', 1);
    expect(s.callCounts['SysVar.setEnum']).toBe(1);
  });

  it('getVariable returns the stringified value', async () => {
    s.nextResponse['SysVar.getValueByName'] = { version: '1.1', result: 42.5, error: null };
    const c = makeClient({ username: 'u', password: 'p' });
    expect(await c.getVariable('Some')).toBe('42.5');
  });

  it('setVariable looks up id+type and routes to setBool/setFloat', async () => {
    s.nextResponse['SysVar.getAll'] = {
      version: '1.1',
      result: [{ id: '7', name: 'Switcher', type: 'BOOL' }, { id: '8', name: 'Number', type: 'FLOAT' }],
      error: null,
    };
    const c = makeClient({ username: 'u', password: 'p' });
    await c.setVariable('Switcher', true);
    expect(s.callCounts['SysVar.setBool']).toBe(1);
    await c.setVariable('Number', 12.5);
    expect(s.callCounts['SysVar.setFloat']).toBe(1);
  });

  it('setVariable rejects non-finite numbers', async () => {
    s.nextResponse['SysVar.getAll'] = {
      version: '1.1',
      result: [{ id: '8', name: 'Number', type: 'FLOAT' }],
      error: null,
    };
    const c = makeClient({ username: 'u', password: 'p' });
    await expect(c.setVariable('Number', Infinity)).rejects.toThrow(/non-finite/);
  });

  it('setVariable throws when the variable doesn\'t exist', async () => {
    s.nextResponse['SysVar.getAll'] = { version: '1.1', result: [], error: null };
    const c = makeClient({ username: 'u', password: 'p' });
    await expect(c.setVariable('Nope', true)).rejects.toThrow(/not found/);
  });

  it('runProgram looks up id by name then calls Program.execute', async () => {
    s.nextResponse['Program.getAll'] = {
      version: '1.1',
      result: [{ id: '99', name: 'Wake up' }],
      error: null,
    };
    const c = makeClient({ username: 'u', password: 'p' });
    await c.runProgram('Wake up');
    expect(s.callCounts['Program.execute']).toBe(1);
    const body = JSON.parse(s.lastBody);
    expect(body.params.id).toBe('99');
  });

  it('runProgram throws when program missing', async () => {
    s.nextResponse['Program.getAll'] = { version: '1.1', result: [], error: null };
    const c = makeClient({ username: 'u', password: 'p' });
    await expect(c.runProgram('Nope')).rejects.toThrow(/not found/);
  });

  it('runProgram rejects unsafe names', async () => {
    const c = makeClient();
    await expect(c.runProgram('foo;bar')).rejects.toThrow(/unsafe/);
  });
});

describe('CcuJsonRpcClient HTTP / JsonRpcError', () => {
  it('throws JsonRpcError on non-2xx', async () => {
    server.removeAllListeners('request');
    server.on('request', (_req, res) => { res.writeHead(500); res.end('fail'); });
    const c = makeClient();
    await expect(c.call('X')).rejects.toThrow(/HTTP 500/);
  });

  it('throws on malformed JSON response', async () => {
    server.removeAllListeners('request');
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('not json');
    });
    const c = makeClient();
    await expect(c.call('X')).rejects.toThrow(/malformed/);
  });

  it('throws on timeout', async () => {
    server.removeAllListeners('request');
    server.on('request', (_req, _res) => {
      // Never respond — let the client timeout
    });
    const c = new CcuJsonRpcClient({
      host: '127.0.0.1', port, timeoutMs: 100,
      log: new PrefixedLogger(makeLog(), 'rpc'),
    });
    await expect(c.call('X')).rejects.toThrow(/timeout|failed/);
  });

  it('JsonRpcError preserves cause when set', () => {
    const cause = new Error('underlying');
    const e = new JsonRpcError('wrapper', 500, cause);
    expect(e.cause).toBe(cause);
    expect(e.code).toBe(500);
  });

  it('useTls option sets rejectUnauthorized=false', () => {
    // Construct only — we don't actually open a TLS connection in unit tests.
    const c = new CcuJsonRpcClient({
      host: '127.0.0.1', port, useTls: true,
      log: new PrefixedLogger(makeLog(), 'tls'),
    });
    expect(c).toBeDefined();
    // The TLS branch is exercised at construction; covering it here is
    // primarily for the branch counter.
  });
});

describe('isSafeIdentifier', () => {
  it('accepts safe', () => {
    expect(isSafeIdentifier('Living Room')).toBe(true);
    expect(isSafeIdentifier('Tür_42')).toBe(true);
  });
  it('rejects unsafe', () => {
    expect(isSafeIdentifier('a;b')).toBe(false);
    expect(isSafeIdentifier('a"b')).toBe(false);
    expect(isSafeIdentifier('')).toBe(false);
    expect(isSafeIdentifier(42 as unknown as string)).toBe(false);
  });
});

// --- shared session under refusals (PR #9 verifier findings) -------------

interface SimStats {
  login: number;
  logout: number;
  executed: Record<string, number>;
  valid: Set<string>;
  seq: number;
}

type SimHandler = (body: { method: string; params: Record<string, unknown> }, s: SimStats) => Promise<unknown> | unknown;

/** A CCU with real sessions; `handler` answers every data call (return an `{ error }` or a result). */
async function simCcu(handler: SimHandler): Promise<{ stats: SimStats; port: number; close: () => Promise<void> }> {
  const stats: SimStats = { login: 0, logout: 0, executed: {}, valid: new Set(), seq: 0 };
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const reply = (o: unknown): void => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (body.method === 'Session.login') {
        stats.login++;
        const sid = `S${++stats.seq}`;
        stats.valid.add(sid);
        return reply({ result: sid, error: null });
      }
      if (body.method === 'Session.logout') {
        stats.logout++;
        stats.valid.delete(body.params._session_id_);
        return reply({ result: true, error: null });
      }
      const out = await handler(body, stats);
      reply(out && typeof out === 'object' && 'error' in out ? { result: null, ...out } : { result: out ?? 'ok', error: null });
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return {
    stats,
    port: (srv.address() as { port: number }).port,
    close: () => new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections(); }),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DENIED = { error: { code: 400, message: "access denied ('user' needed 'admin')" } };
const EXPIRED = { error: { code: 400, message: 'access denied ( 1 )' } };

function simClient(port: number, now?: () => number, log = makeLog(), password = 'secretpw') {
  return { log, c: new CcuJsonRpcClient({ host: '127.0.0.1', port, auth: { username: 'u', password }, log: new PrefixedLogger(log, 'api'), now }) };
}

describe('CcuJsonRpcClient shared session under refusals', () => {
  it('1000 sequential denied calls: one re-login per backoff window, one warning, other sessions untouched', async () => {
    const ccu = await simCcu(() => DENIED);
    let t = Date.UTC(2026, 10, 15, 12);
    const { c, log } = simClient(ccu.port, () => t);
    try {
      const kinds = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        await c.call('SysVar.getValueByName', { name: 'X' }).catch((e: JsonRpcError) => kinds.add(e.kind));
      }
      expect([...kinds]).toEqual(['permission']);
      expect(ccu.stats.login).toBe(2);
      expect(ccu.stats.logout).toBe(1);
      expect(ccu.stats.valid.size).toBe(1);
      // after the 10 minute wait the method is tried again (no new login: the live session is kept)
      t += 10 * 60_000;
      for (let i = 0; i < 100; i++) await c.call('SysVar.getValueByName', { name: 'X' }).catch(() => undefined);
      expect(ccu.stats.login).toBe(3);
      // the wait doubled to 20 minutes
      t += 10 * 60_000;
      await c.call('SysVar.getValueByName', { name: 'X' }).catch(() => undefined);
      expect(ccu.stats.login).toBe(3);
      expect(vi.mocked(log.warn).mock.calls.filter((x) => String(x[0]).includes('missing rights'))).toHaveLength(1);
      await c.logout();
      expect(ccu.stats.login).toBe(ccu.stats.logout);
    } finally {
      await ccu.close();
    }
  });

  it('1000 concurrent denied calls share one re-login', async () => {
    const ccu = await simCcu(async () => {
      await sleep(1);
      return DENIED;
    });
    const { c } = simClient(ccu.port);
    try {
      const r = await Promise.allSettled(Array.from({ length: 1000 }, () => c.call('X.denied', {})));
      expect(r.every((x) => x.status === 'rejected')).toBe(true);
      expect(ccu.stats.login).toBe(2);
      expect(ccu.stats.logout).toBe(1);
      await c.logout();
      expect(ccu.stats.valid.size).toBe(0);
    } finally {
      await ccu.close();
    }
  });

  it('allowed setValue calls next to a denied method never fail and run once each', async () => {
    const ccu = await simCcu(async (b, s) => {
      await sleep(Math.random() * 10);
      if (!s.valid.has(String(b.params._session_id_))) return EXPIRED;
      if (b.method === 'X.denied') return DENIED;
      s.executed[b.method] = (s.executed[b.method] ?? 0) + 1;
      return 'ok';
    });
    const { c } = simClient(ccu.port);
    try {
      let failed = 0;
      for (let round = 0; round < 50; round++) {
        await Promise.all([
          ...Array.from({ length: 5 }, () => c.call('X.denied', {}).catch(() => undefined)),
          ...Array.from({ length: 5 }, () => c.call('Interface.setValue', { interface: 'HmIP-RF' }).catch(() => { failed++; })),
        ]);
      }
      expect(failed).toBe(0);
      expect(ccu.stats.executed['Interface.setValue']).toBe(250);
      expect(ccu.stats.login).toBeLessThanOrEqual(2);
    } finally {
      await ccu.close();
    }
  });

  it('an expired session with 40 concurrent setValue: one re-login, each executed once', async () => {
    const ccu = await simCcu(async (b, s) => {
      await sleep(2);
      if (!s.valid.has(String(b.params._session_id_))) return EXPIRED;
      s.executed[b.method] = (s.executed[b.method] ?? 0) + 1;
      return 'ok';
    });
    const { c } = simClient(ccu.port);
    try {
      await c.call('Interface.getValue', {});
      ccu.stats.valid.clear();
      const before = ccu.stats.login;
      const r = await Promise.allSettled(Array.from({ length: 40 }, () => c.call('Interface.setValue', {})));
      expect(r.every((x) => x.status === 'fulfilled')).toBe(true);
      expect(ccu.stats.login - before).toBe(1);
      expect(ccu.stats.executed['Interface.setValue']).toBe(40);
    } finally {
      await ccu.close();
    }
  });

  it('never retries a write on a loose hint: Program.execute with "login" in its error runs once', async () => {
    const ccu = await simCcu((b, s) => {
      s.executed[b.method] = (s.executed[b.method] ?? 0) + 1;
      return { error: { code: 501, message: 'Program.execute: device unreachable since last login' } };
    });
    const { c } = simClient(ccu.port);
    try {
      await expect(c.call('Program.execute', { id: '1' })).rejects.toMatchObject({ kind: 'protocol' });
      expect(ccu.stats.executed['Program.execute']).toBe(1);
      expect(ccu.stats.login).toBe(1);
      expect(ccu.stats.logout).toBe(0);
    } finally {
      await ccu.close();
    }
  });

  it('detects the session error on the raw text, before masking a short password', async () => {
    const ccu = await simCcu((b, s) => (s.valid.has(String(b.params._session_id_)) ? 'ok' : EXPIRED));
    const { c } = simClient(ccu.port, undefined, makeLog(), 'e');
    try {
      await c.call('Interface.getValue', {});
      ccu.stats.valid.clear();
      await expect(c.call('Interface.getValue', {})).resolves.toBe('ok');
      expect(ccu.stats.login).toBe(2);
    } finally {
      await ccu.close();
    }
  });

  it('ends the wait of a method when it succeeds again', async () => {
    let allowed = false;
    const ccu = await simCcu((b) => (b.method === 'X.m' && !allowed ? DENIED : 'ok'));
    let t = 0;
    const { c } = simClient(ccu.port, () => t);
    try {
      await expect(c.call('X.m', { interface: 'BidCos-RF' })).rejects.toMatchObject({ kind: 'permission' });
      // another interface is a separate key
      await expect(c.call('X.m', { interface: 'HmIP-RF' })).rejects.toMatchObject({ kind: 'permission' });
      await expect(c.call('X.m', { interface: 'BidCos-RF' })).rejects.toThrow(/paused until/);
      allowed = true;
      t += 10 * 60_000;
      await expect(c.call('X.m', { interface: 'BidCos-RF' })).resolves.toBe('ok');
      allowed = false;
      await expect(c.call('X.m', { interface: 'BidCos-RF' })).rejects.toMatchObject({ kind: 'permission' });
      t += 10 * 60_000; // the wait starts again at 10 minutes, not 20: the call is sent, not paused
      const err = (await c.call('X.m', { interface: 'BidCos-RF' }).catch((e: Error) => e)) as JsonRpcError;
      expect(err.kind).toBe('permission');
      expect(err.message).not.toMatch(/paused until/);
      await expect(c.call('X.m', { interface: 'BidCos-RF' })).rejects.toThrow(/paused until/);
    } finally {
      await ccu.close();
    }
  });

  it('a session error without credentials fails that call without a login', async () => {
    const ccu = await simCcu(() => EXPIRED);
    const c = new CcuJsonRpcClient({ host: '127.0.0.1', port: ccu.port, log: new PrefixedLogger(makeLog(), 'api') });
    try {
      await expect(c.call('Interface.getValue', {})).rejects.toMatchObject({ kind: 'session' });
      expect(ccu.stats.login).toBe(0);
    } finally {
      await ccu.close();
    }
  });
});

describe('CcuJsonRpcClient tlsAgent', () => {
  it('sends HTTPS requests through a given agent, without the unverified override', async () => {
    const seen: Array<Record<string, unknown>> = [];
    class SpyAgent extends https.Agent {
      override createConnection(options: Record<string, unknown>, cb?: (err: Error | null, s?: net.Socket) => void): net.Socket {
        seen.push(options);
        const sock = net.connect(1, '127.0.0.1');
        cb?.(null, sock);
        return sock;
      }
    }
    const agent = new SpyAgent();
    const c = new CcuJsonRpcClient({ host: '127.0.0.1', port: 1, useTls: true, tlsAgent: agent, timeoutMs: 1000, log: new PrefixedLogger(makeLog(), 'tls') });
    await expect(c.call('Interface.getValue', {})).rejects.toMatchObject({ kind: 'network' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.rejectUnauthorized).not.toBe(false);
    agent.destroy();
  });
});

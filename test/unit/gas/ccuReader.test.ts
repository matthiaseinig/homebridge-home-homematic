import { describe, expect, it } from 'vitest';
import { JsonRpcError } from '../../../src/ccu/CcuJsonRpcClient.js';
import {
  assertAllowed,
  ccuBool,
  ccuNumber,
  GAS_CCU_METHODS,
  GasCcuError,
  GasCcuReader,
  MAX_AUTH_BACKOFF_MS,
} from '../../../src/gas/ccuReader.js';
import { ADDRESS, cleanup, clock, fakeCcu, HOST, PASSWORD, reader, sharedSession, USER } from './helpers.js';

cleanup();

const IFACE = 'BidCos-RF';
const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);

describe('gas CCU allow-list', () => {
  it('is exactly the three read-only data methods', () => {
    expect([...GAS_CCU_METHODS]).toEqual(['Interface.getValue', 'Interface.getParamset', 'Interface.getParamsetDescription']);
    expect(Object.isFrozen(GAS_CCU_METHODS)).toBe(true);
  });

  it('refuses every other method and any paramset but VALUES', () => {
    for (const m of ['Interface.setValue', 'Interface.putParamset', 'ReGa.runScript', 'SysVar.setFloat', 'Program.execute', 'Session.login']) {
      expect(() => assertAllowed(m, {}), m).toThrow(GasCcuError);
    }
    expect(() => assertAllowed('Interface.getParamset', { paramsetKey: 'MASTER' })).toThrow(/VALUES/);
    expect(() => assertAllowed('Interface.getParamsetDescription', { paramsetType: 'MASTER' })).toThrow(/VALUES/);
    expect(() => assertAllowed('Interface.getParamset', { paramsetKey: 'VALUES' })).not.toThrow();
  });

  it('puts nothing but read calls and the shared session handling on the wire', async () => {
    const ccu = await fakeCcu();
    const api = sharedSession(ccu.port);
    const r = reader(api, () => T0);
    await r.describeValues(IFACE, `${ADDRESS}:1`);
    await r.getValues(IFACE, `${ADDRESS}:1`);
    await r.getValue(IFACE, `${ADDRESS}:0`, 'UNREACH');
    ccu.expireSessions();
    await r.getValue(IFACE, `${ADDRESS}:0`, 'LOWBAT');
    await api.logout();
    const allowed = new Set<string>([...GAS_CCU_METHODS, 'Session.login', 'Session.logout']);
    for (const call of ccu.calls) {
      expect(allowed.has(call.method), call.method).toBe(true);
      expect(call.httpMethod).toBe('POST');
      expect(call.path).toBe('/api/homematic.cgi');
      if (call.method === 'Interface.getParamset') expect(call.params.paramsetKey).toBe('VALUES');
      if (call.method === 'Interface.getParamsetDescription') expect(call.params.paramsetType).toBe('VALUES');
    }
    expect(ccu.methods()).not.toContain('Interface.setValue');
  });
});

describe('shared CCU session', () => {
  it('logs in once, reuses the session and shares one login between concurrent first calls', async () => {
    const ccu = await fakeCcu();
    const api = sharedSession(ccu.port);
    const r = reader(api, () => T0);
    await Promise.all([r.getValues(IFACE, `${ADDRESS}:1`), r.getValue(IFACE, `${ADDRESS}:0`, 'UNREACH')]);
    for (let i = 0; i < 3; i++) await r.getValues(IFACE, `${ADDRESS}:1`);
    expect(ccu.logins).toBe(1);
    expect(r.hasSession).toBe(true);
    const sids = ccu.calls.filter((x) => x.method !== 'Session.login').map((x) => x.params._session_id_);
    expect(new Set(sids)).toEqual(new Set(['sid1x']));
  });

  it('replaces an expired session once (the CCU says access denied) and logs the old one out', async () => {
    const ccu = await fakeCcu();
    const api = sharedSession(ccu.port);
    const r = reader(api, () => T0);
    await r.getValues(IFACE, `${ADDRESS}:1`);
    ccu.expireSessions();
    await expect(r.getValues(IFACE, `${ADDRESS}:1`)).resolves.toBeDefined();
    expect(ccu.logins).toBe(2);
    const logouts = ccu.calls.filter((c) => c.method === 'Session.logout');
    expect(logouts.map((c) => c.params._session_id_)).toEqual(['sid1x']);
    expect(r.retryAt).toBeUndefined();
  });

  it('does not log in again on a plain error or a network failure', async () => {
    const ccu = await fakeCcu();
    const api = sharedSession(ccu.port);
    const r = reader(api, () => T0);
    await r.getValues(IFACE, `${ADDRESS}:1`);
    await expect(r.getValue(IFACE, `${ADDRESS}:0`, 'NOPE')).rejects.toMatchObject({ kind: 'protocol' });
    await ccu.close();
    await expect(r.getValues(IFACE, `${ADDRESS}:1`)).rejects.toMatchObject({ kind: 'network' });
    expect(ccu.logins).toBe(1);
    expect(r.retryAt).toBeUndefined();
  });

  it('logs out on logout() and leaves no session of a login in flight', async () => {
    const ccu = await fakeCcu();
    const api = sharedSession(ccu.port);
    const pending = api.call('Interface.getParamset', { interface: IFACE, address: `${ADDRESS}:1`, paramsetKey: 'VALUES' });
    await api.logout();
    await pending.catch(() => undefined);
    await api.logout();
    expect(ccu.sessions.size).toBe(0);
    expect(ccu.created).toBe(ccu.logouts);
  });
});

describe('gas CCU backoff (verifier finding 1)', () => {
  it('a session that logs in but is refused counts as a failure: 61 polls, doubling waits, logins == logouts', async () => {
    const ccu = await fakeCcu();
    ccu.noRights = true;
    const t = clock(T0);
    const api = sharedSession(ccu.port);
    const r = reader(api, t.now, 60_000);
    const attempts: number[] = [];
    for (let poll = 0; poll < 61; poll++) {
      const before = ccu.logins;
      const err = (await r.getValues(IFACE, `${ADDRESS}:1`).catch((e: Error) => e)) as GasCcuError;
      expect(err).toBeInstanceOf(GasCcuError);
      expect(err.kind).toBe('auth');
      if (ccu.logins > before) {
        attempts.push(t.now());
        // one fresh session per attempt: the refused one and its replacement, both logged out
        expect(ccu.logins - before).toBe(2);
        expect(err.message).toMatch(/rights of the CCU user/);
      } else {
        expect(err.message).toMatch(/paused/);
      }
      expect(ccu.sessions.size).toBe(0);
      t.add(60_000);
    }
    const waits = attempts.slice(1).map((a, i) => (a - attempts[i]!) / 1000);
    expect(waits).toEqual([60, 120, 240, 480, 600, 600, 600, 600]);
    expect(Math.max(...waits) * 1000).toBe(MAX_AUTH_BACKOFF_MS);
    expect(r.authState.failures).toBe(9);
    expect(ccu.logins).toBe(18);
    expect(ccu.created).toBe(18);
    expect(ccu.logouts).toBe(18);

    // Rights fixed: the next attempt after the wait succeeds and only that ends the backoff.
    ccu.noRights = false;
    t.set(r.retryAt!);
    await expect(r.getValues(IFACE, `${ADDRESS}:1`)).resolves.toBeDefined();
    expect(r.authState).toEqual({ failures: 0, blockedUntil: 0 });
    await api.logout();
    expect(ccu.created).toBe(ccu.logouts);
  });

  it('a login alone does not end the backoff; a refused data call after it doubles the wait', async () => {
    const ccu = await fakeCcu();
    ccu.noRights = true;
    const t = clock(T0);
    const api = sharedSession(ccu.port);
    const r = reader(api, t.now, 60_000);
    const states: number[] = [];
    r.onAuthState = (s) => states.push(s.failures);
    await r.getValues(IFACE, `${ADDRESS}:1`).catch(() => undefined);
    t.set(r.retryAt!);
    await r.getValues(IFACE, `${ADDRESS}:1`).catch(() => undefined);
    // logins worked both times, yet the failures only grew
    expect(states).toEqual([1, 2]);
    expect(r.retryAt! - t.now()).toBe(120_000);
  });

  it('backs off after rejected logins and sends nothing while paused', async () => {
    const ccu = await fakeCcu();
    ccu.rejectLogin = true;
    const t = clock(T0);
    const r = reader(sharedSession(ccu.port), t.now, 60_000);
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      await expect(r.getValues(IFACE, `${ADDRESS}:1`)).rejects.toMatchObject({ kind: 'auth' });
      const retry = r.retryAt!;
      waits.push(retry - t.now());
      t.add(retry - t.now() - 1);
      const before = ccu.calls.length;
      await expect(r.getValues(IFACE, `${ADDRESS}:1`)).rejects.toThrow(/paused/);
      expect(ccu.calls.length).toBe(before);
      t.add(1);
    }
    expect(waits).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
    expect(ccu.logins).toBe(6);
  });

  it('restores a saved backoff, never further than one maximum wait ahead', () => {
    const t = clock(T0);
    const r = new GasCcuReader({ call: async () => ({}), hasSession: false }, { authBackoffMs: 60_000, now: t.now, redact: [] });
    r.restoreAuthState({ failures: 3, blockedUntil: T0 + 10 * MAX_AUTH_BACKOFF_MS });
    expect(r.authState).toEqual({ failures: 3, blockedUntil: T0 + MAX_AUTH_BACKOFF_MS });
    const r2 = new GasCcuReader({ call: async () => ({}), hasSession: false }, { authBackoffMs: 60_000, now: t.now, redact: [] });
    r2.restoreAuthState({ failures: 0, blockedUntil: T0 + 1000 });
    r2.restoreAuthState({ failures: 1.5, blockedUntil: T0 + 1000 });
    expect(r2.retryAt).toBeUndefined();
  });

  it('treats a session error without configured credentials as a failure too', async () => {
    const t = clock(T0);
    const r = new GasCcuReader({
      call: async () => {
        throw new JsonRpcError('Interface.getParamset: access denied ( 1 )', 400, undefined, 'session');
      },
      hasSession: false,
    }, { authBackoffMs: 30_000, now: t.now, redact: [] });
    await expect(r.getValues(IFACE, `${ADDRESS}:1`)).rejects.toMatchObject({ kind: 'auth' });
    expect(r.retryAt).toBe(T0 + 30_000);
  });
});

describe('gas CCU error texts (verifier finding 2)', () => {
  it('masks the device address, the CCU host, the user and any IPv4 address, case insensitive', async () => {
    const ccu = await fakeCcu();
    ccu.handler = (call) => call.method === 'Interface.getParamset'
      ? { error: { code: 501, message: `no channel ${ADDRESS.toLowerCase()}:1 on ${HOST}; peer 198.51.100.7 for ${USER} (${PASSWORD})` } }
      : undefined;
    const r = reader(sharedSession(ccu.port), () => T0);
    const err = (await r.getValues(IFACE, `${ADDRESS}:1`).catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(GasCcuError);
    for (const secret of [ADDRESS, ADDRESS.toLowerCase(), HOST, '198.51.100.7', USER, PASSWORD]) {
      expect(err.message).not.toContain(secret);
    }
    expect(err.message).toContain('***');
  });

  it('never carries the password or the session id from a rejected login', async () => {
    const ccu = await fakeCcu();
    ccu.rejectLogin = true;
    const r = reader(sharedSession(ccu.port), () => T0);
    const err = (await r.getValues(IFACE, `${ADDRESS}:1`).catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain(PASSWORD);
    expect(err.message).not.toContain(USER);
    ccu.rejectLogin = false;
    ccu.handler = (call) => call.method === 'Interface.getValue'
      ? { error: { code: 501, message: `bad value for ${String(call.params._session_id_)}` } }
      : undefined;
    const r2 = reader(sharedSession(ccu.port), () => T0);
    const e2 = (await r2.getValue(IFACE, `${ADDRESS}:0`, 'UNREACH').catch((e: Error) => e)) as Error;
    expect(e2.message).not.toMatch(/sid\d+x/);
  });

  it('cuts texts to printable ASCII and 120 characters', () => {
    const r = new GasCcuReader({ call: async () => ({}), hasSession: false }, { authBackoffMs: 1, redact: ['', ' '] });
    const s = r.clean(`a\u0000b${'x'.repeat(300)}`);
    expect(s.startsWith('a b')).toBe(true);
    expect(s).toHaveLength(120);
  });
});

describe('gas CCU value parsing', () => {
  it('reads numbers and flags in the forms the CCU sends', () => {
    expect(ccuNumber('123.400000')).toBe(123.4);
    expect(ccuNumber(5)).toBe(5);
    expect(ccuNumber(' 7 ')).toBe(7);
    expect(ccuNumber('1e3')).toBe(1000);
    for (const v of ['', 'abc', null, undefined, Number.NaN, Infinity, '1,5', {}]) {
      expect(ccuNumber(v), String(v)).toBeUndefined();
    }
    expect([true, 1, '1', 'true'].map(ccuBool)).toEqual([true, true, true, true]);
    expect([false, 0, '0', 'false'].map(ccuBool)).toEqual([false, false, false, false]);
    expect(ccuBool('')).toBeUndefined();
  });

  it('rejects a paramset that is no object', async () => {
    const r = new GasCcuReader({ call: async () => 'x', hasSession: true }, { authBackoffMs: 1, redact: [] });
    await expect(r.getValues(IFACE, `${ADDRESS}:1`)).rejects.toThrow(/no paramset/);
  });
});

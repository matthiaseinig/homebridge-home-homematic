import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CharValues } from '../../../src/gas/definitions.js';
import { credentialKey, GAS_STATE_FILE } from '../../../src/gas/history.js';
import { GAS_REBASE_AFTER, GasService } from '../../../src/gas/service.js';
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

const T0 = Date.UTC(2026, 10, 15, 9, 0, 0); // 10:00 local

async function setup(extra: Record<string, unknown> = {}, start = T0, dir?: string) {
  const ccu = await fakeCcu();
  const d = dir ?? (await tempDir());
  const t = clock(start);
  const log = recordingLog();
  const published: CharValues[] = [];
  let api = sharedSession(ccu.port, log, 2000, t.now);
  /** A new service on a new shared session, as after a Homebridge restart. */
  const make = (authKey = credentialKey(HOST, USER, PASSWORD)) => {
    api = sharedSession(ccu.port, log, 2000, t.now);
    return new GasService(gasSettings(extra), d, prefixed(log), {
      reader: reader(api, t.now, 60_000),
      authKey,
      now: t.now,
      setTimer: () => 0,
      clearTimer: () => undefined,
      onValues: (v) => published.push(v),
    });
  };
  /** Stop the service and log the shared session out, as the plugin's shutdown does. */
  const stop = async (svc: GasService) => {
    await svc.stop();
    await api.logout();
  };
  return { ccu, dir: d, t, log, published, make, stop };
}

const counter = (m3: number, flow = 0) => ({ GAS_ENERGY_COUNTER: m3.toFixed(6), GAS_POWER: flow.toFixed(6) });

describe('GasService polling', () => {
  it('sets the baseline, records counter steps per local day and publishes HomeKit values', async () => {
    const { ccu, t, published, make, stop } = await setup();
    ccu.values = counter(1000);
    const svc = make();
    await svc.start();
    await svc.ready;
    expect(published.at(-1)).toMatchObject({
      GasMeterReading: 1000,
      GasFlow: 0,
      GasToday: 0,
      GasReachable: true,
      GasLowBattery: false,
      GasFactor: 10.64,
      LastUpdate: T0 / 1000,
    });
    for (const [m3, flow] of [[1000.1, 0.9], [1000.25, 1.2], [1000.4, 1.5]] as const) {
      t.add(60_000);
      ccu.values = counter(m3, flow);
      await svc.pollOnce();
    }
    const v = published.at(-1)!;
    expect(v).toMatchObject({ GasToday: 0.4, GasMonth: 0.4, GasMonthKwh: 4.256, GasFlow: 1.5 });
    expect(v.GasYesterday).toBeUndefined();
    expect(await svc.history.liveRows('2026-11-15')).toEqual([[T0 / 1000, 0.9, 1.5, 0.4]]);
    await stop(svc);
  });

  it('records nothing while the device is unreachable and counts the gap afterwards', async () => {
    const { ccu, t, published, make, stop } = await setup();
    ccu.values = counter(50);
    const svc = make();
    await svc.start();
    await svc.ready;
    ccu.unreach = true;
    for (let i = 0; i < 30; i++) {
      t.add(60_000);
      ccu.values = counter(50, 0.4); // the CCU repeats the stale value
      await svc.pollOnce();
    }
    const off = published.at(-1)!;
    expect(off.GasReachable).toBe(false);
    expect(off.GasFlow).toBeUndefined();
    expect(off.GasMeterReading).toBeUndefined();
    expect(off.LastUpdate).toBe(T0 / 1000);
    ccu.unreach = false;
    t.add(60_000);
    ccu.values = counter(53, 2);
    await svc.pollOnce();
    expect(published.at(-1)).toMatchObject({ GasToday: 3, GasReachable: true, GasMeterReading: 53 });
    await stop(svc);
  });

  it('shows a device that does not answer as unreachable, not as CCU not readable, and sends no paramset request', async () => {
    const { ccu, log, published, make, stop } = await setup();
    const svc = make();
    await svc.start();
    await svc.ready;
    ccu.unreach = true;
    const before = ccu.calls.length;
    ccu.handler = (c) => (c.method === 'Interface.getParamset' ? { error: { code: 501, message: 'XML-RPC: general error' } } : undefined);
    await svc.pollOnce();
    await svc.pollOnce();
    expect(published.at(-1)!.GasReachable).toBe(false);
    expect(log.lines.filter((l) => l.includes('CCU not readable'))).toHaveLength(0);
    const sent = ccu.calls.slice(before).map((c) => `${c.method}:${String(c.params.valueKey ?? '')}`);
    expect(sent).toEqual(['Interface.getValue:UNREACH', 'Interface.getValue:UNREACH']);
    await stop(svc);
  });

  it('holds a read of 0, re-bases on a glitch, counts a real reset and drops implausible jumps', async () => {
    const { ccu, t, published, log, make, stop } = await setup();
    ccu.values = counter(200);
    const svc = make();
    await svc.start();
    await svc.ready;
    const step = async (m3: number) => {
      t.add(60_000);
      ccu.values = counter(m3);
      await svc.pollOnce();
      return published.at(-1)!.GasToday;
    };
    expect(await step(0)).toBe(0); // held
    expect(await step(200.1)).toBe(0.1); // back at or above the baseline: glitch, counting continues
    expect(await step(0)).toBe(0.1);
    expect(await step(0)).toBe(0.1);
    expect(await step(0.05)).toBe(0.15); // below 1 m³: the sensor restarted, 0.05 since then
    expect(await step(5)).toBe(0.15); // 4.95 m³ in a minute: implausible, dropped and re-based
    expect(await step(5.2)).toBe(0.35);
    expect(log.lines.some((l) => l.includes('counter restarted'))).toBe(true);
    expect(log.lines.some((l) => l.includes('implausible counter jump'))).toBe(true);
    await stop(svc);
  });

  it('holds a drop to 1 m³ or more as a glitch and re-bases only after it stays there', async () => {
    const { ccu, t, published, log, make, stop } = await setup();
    ccu.values = counter(500);
    const svc = make();
    await svc.start();
    await svc.ready;
    const step = async (m3: number) => {
      t.add(60_000);
      ccu.values = counter(m3);
      await svc.pollOnce();
      return published.at(-1)!.GasToday;
    };
    expect(await step(120)).toBe(0); // a drop, but not to near 0: glitch, nothing counted
    expect(await step(500.2)).toBeCloseTo(0.2, 6); // back above the baseline: continue
    for (let i = 0; i < GAS_REBASE_AFTER; i++) expect(await step(42 + i * 0.01)).toBeCloseTo(0.2, 6);
    // stayed below for GAS_REBASE_AFTER polls (a replaced device): new baseline, nothing counted
    expect(await step(42.2)).toBeCloseTo(0.31, 6);
    // warned once per episode below the baseline (the single 120, then the run at 42)
    expect(log.lines.filter((l) => l.includes('ignored as a read glitch'))).toHaveLength(2);
    expect(log.lines.some((l) => l.includes('re-based without counting'))).toBe(true);
    expect(log.lines.some((l) => l.includes('counter restarted'))).toBe(false);
    await stop(svc);
  });

  it('marks device values unknown while the CCU is not readable, and logs the change once', async () => {
    const { ccu, t, published, log, make, stop } = await setup();
    const svc = make();
    await svc.start();
    await svc.ready;
    await ccu.close();
    for (let i = 0; i < 3; i++) {
      t.add(60_000);
      await svc.pollOnce();
    }
    const v = published.at(-1)!;
    expect(v.GasReachable).toBeUndefined();
    expect(v.GasLowBattery).toBeUndefined();
    expect(v.GasFlow).toBeUndefined();
    expect(v.GasMeterReading).toBeUndefined();
    expect(v.GasToday).toBe(0);
    expect(v.GasFactor).toBe(10.64);
    expect(log.lines.filter((l) => l.includes('CCU not readable'))).toHaveLength(1);
    expect(svc.reading.lastError).toMatch(/failed/);
    await stop(svc);
  });

  it('reports when the CCU is readable again', async () => {
    const { ccu, t, log, make, stop } = await setup();
    let down = true;
    ccu.handler = (c) => (down && c.method === 'Interface.getParamset' ? { error: { code: 501, message: 'busy' } } : undefined);
    const svc = make();
    await svc.start();
    await svc.ready;
    down = false;
    t.add(60_000);
    await svc.pollOnce();
    expect(log.lines.some((l) => l.includes('CCU readable again'))).toBe(true);
    await stop(svc);
  });

  it('treats unreadable channel 0 flags as unknown (warned once) and still records', async () => {
    const { ccu, t, published, log, make, stop } = await setup();
    ccu.handler = (c) => (c.method === 'Interface.getValue' ? { error: { code: 501, message: 'unknown datapoint' } } : undefined);
    ccu.values = counter(5);
    const svc = make();
    await svc.start();
    await svc.ready;
    t.add(60_000);
    ccu.values = counter(5.1);
    await svc.pollOnce();
    const v = published.at(-1)!;
    expect(v.GasReachable).toBeUndefined();
    expect(v.GasLowBattery).toBeUndefined();
    expect(v.GasToday).toBe(0.1);
    expect(log.lines.filter((l) => l.includes('UNREACH of channel 0'))).toHaveLength(1);
    await stop(svc);
  });

  it('ignores counter and flow values that are missing or negative', async () => {
    const { ccu, published, make, stop } = await setup();
    ccu.values = { GAS_ENERGY_COUNTER: '', GAS_POWER: '-1' };
    const svc = make();
    await svc.start();
    await svc.ready;
    const v = published.at(-1)!;
    expect(v.GasMeterReading).toBeUndefined();
    expect(v.GasFlow).toBeUndefined();
    expect(v.LastUpdate).toBe(T0 / 1000);
    await stop(svc);
  });

  it('shows the latest meter reading plus what was recorded after it', async () => {
    const { ccu, t, published, make, stop } = await setup({ meterReadings: [{ date: '2026-11-15', time: '10:00', m3: 4321.5 }] });
    ccu.values = counter(100);
    const svc = make();
    await svc.start();
    await svc.ready;
    t.add(10 * 60_000);
    ccu.values = counter(100.4);
    await svc.pollOnce();
    expect(published.at(-1)!.GasMeterReading).toBe(4321.9);
    await stop(svc);
  });

  it('never logs the device address, the CCU host or an IPv4 address from a CCU error', async () => {
    const { ccu, log, make, stop } = await setup();
    ccu.handler = (c) => (c.method === 'Interface.getParamset'
      ? { error: { code: 501, message: `device ${ADDRESS}:1 unknown at ${HOST} via 203.0.113.9` } }
      : undefined);
    const svc = make();
    await svc.start();
    await svc.ready;
    expect(svc.reading.lastError).toContain('***');
    const all = log.lines.join('\n');
    for (const s of [ADDRESS, HOST, '203.0.113.9', PASSWORD]) expect(all).not.toContain(s);
    await stop(svc);
  });
});

describe('GasService restarts (verifier finding 3)', () => {
  it('keeps the counter baseline across a restart and counts what was used while stopped', async () => {
    const first = await setup();
    first.ccu.values = counter(10);
    const a = first.make();
    await a.start();
    await a.ready;
    await first.stop(a);
    const saved = JSON.parse(await readFile(join(first.dir, GAS_STATE_FILE), 'utf8'));
    expect(saved).toEqual({ version: 1, counter: 10, at: T0 });
    first.t.add(2 * 3_600_000);
    first.ccu.values = counter(12.5);
    const b = first.make();
    await b.start();
    await b.ready;
    expect(first.published.at(-1)!.GasToday).toBe(2.5);
    await first.stop(b);
  });

  it('after a restart a drop below the saved baseline is a reset only below 1 m³, otherwise a glitch', async () => {
    const run = async (after: number) => {
      const s = await setup();
      s.ccu.values = counter(800);
      const a = s.make();
      await a.start();
      await a.ready;
      await s.stop(a);
      s.t.add(3_600_000);
      s.ccu.values = counter(after);
      const b = s.make();
      await b.start();
      await b.ready;
      const today = s.published.at(-1)!.GasToday;
      await s.stop(b);
      const state = JSON.parse(await readFile(join(s.dir, GAS_STATE_FILE), 'utf8'));
      return { today, state, log: s.log.lines.join('\n') };
    };
    const restarted = await run(0.4); // the sensor restarted at 0 while Homebridge was down
    expect(restarted.today).toBe(0.4);
    expect(restarted.state.counter).toBe(0.4);
    expect(restarted.log).toContain('counter restarted');

    const glitch = await run(120); // a lower value of 1 m³ or more: a read glitch, not a reset
    expect(glitch.today).toBe(0);
    expect(glitch.state.counter).toBe(800);
    expect(glitch.log).toContain('ignored as a read glitch');
    expect(glitch.log).not.toContain('counter restarted');

    const edge = await run(1); // exactly 1 m³ is not below 1: glitch
    expect(edge.today).toBe(0);
    expect(edge.state.counter).toBe(800);
  });

  it('moves an unreadable state file aside and starts with a fresh baseline', async () => {
    const { dir, ccu, log, published, make, stop } = await setup();
    await writeFile(join(dir, GAS_STATE_FILE), '{broken');
    ccu.values = counter(10);
    const svc = make();
    await svc.start();
    await svc.ready;
    expect(published.at(-1)!.GasToday).toBe(0);
    expect((await readdir(dir)).some((n) => n.startsWith(`${GAS_STATE_FILE}.bak-`))).toBe(true);
    expect(log.lines.some((l) => l.includes('gas meter state was unreadable'))).toBe(true);
    await stop(svc);
  });
});

describe('GasService datapoint check', () => {
  it('logs the units when the datapoints exist', async () => {
    const { log, make, stop } = await setup();
    const svc = make();
    await svc.start();
    await svc.ready;
    expect(svc.datapoints).toMatchObject({ checked: true, found: true });
    expect(log.lines.some((l) => l.startsWith('info') && l.includes('GAS_ENERGY_COUNTER (m3)'))).toBe(true);
    await stop(svc);
  });

  it('warns with the datapoints the channel has when the configured ones are missing', async () => {
    const { ccu, log, make, stop } = await setup({ datapoints: { counter: 'IEC_ENERGY_COUNTER' } });
    ccu.description = { ENERGY_COUNTER: { UNIT: 'Wh' }, POWER: { UNIT: 'W' }, GAS_POWER: {} };
    const svc = make();
    await svc.start();
    await svc.ready;
    expect(svc.datapoints.found).toBe(false);
    const line = log.lines.find((l) => l.startsWith('warn') && l.includes('has no IEC_ENERGY_COUNTER'));
    expect(line).toContain('ENERGY_COUNTER, GAS_POWER, POWER');
    expect(line).toContain('gas.datapoints');
    await stop(svc);
  });

  it('warns when the description cannot be read', async () => {
    const { ccu, log, make, stop } = await setup();
    ccu.handler = (c) => (c.method === 'Interface.getParamsetDescription' ? { error: { code: 501, message: 'nope' } } : undefined);
    const svc = make();
    await svc.start();
    await svc.ready;
    expect(svc.datapoints.checked).toBe(false);
    expect(log.lines.some((l) => l.includes('could not read the datapoint description'))).toBe(true);
    await stop(svc);
  });
});

describe('GasService sessions', () => {
  it('uses one session for every poll; every start logs in once and every shutdown logs out', async () => {
    const { ccu, t, make, stop } = await setup();
    for (let r = 0; r < 6; r++) {
      const svc = make();
      await svc.start();
      await svc.ready;
      for (let i = 0; i < 20; i++) {
        t.add(60_000);
        await svc.pollOnce();
      }
      await stop(svc);
    }
    expect(ccu.logins).toBe(6);
    expect(ccu.logouts).toBe(6);
    expect(ccu.sessions.size).toBe(0);
  });

  it('logs in again once after the CCU forgot the session (reboot) and keeps polling', async () => {
    const { ccu, t, make, stop } = await setup();
    const svc = make();
    await svc.start();
    await svc.ready;
    for (let i = 0; i < 10; i++) {
      if (i === 5) ccu.expireSessions();
      t.add(60_000);
      await svc.pollOnce();
    }
    expect(ccu.logins).toBe(2);
    expect(svc.reading.ccuOk).toBe(true);
    await stop(svc);
  });

  it('without the rights: 61 polls back off with doubling waits and leave no session behind', async () => {
    const { ccu, t, log, make, stop } = await setup();
    ccu.noRights = true;
    const svc = make();
    await svc.start();
    await svc.ready;
    for (let i = 1; i < 61; i++) {
      t.add(60_000);
      await svc.pollOnce();
    }
    // gas attempts at polls 0, 1, 3, 7, 15, 25, 35, 45, 55; a refused method itself is sent only
    // at 0, 15 and 35 minutes (shared per-method backoff), each time replacing the session once:
    // start (description, then UNREACH: 1 + 1 + 1) and 15 and 35 minutes (1 each)
    expect(ccu.logins).toBe(5);
    expect(svc.reader.authState.failures).toBe(9);
    // one warning per refused method (the description and UNREACH), not per poll
    expect(log.lines.filter((l) => l.includes('missing rights?'))).toHaveLength(2);
    await stop(svc);
    expect(ccu.created).toBe(ccu.logouts);
    expect(ccu.sessions.size).toBe(0);
    expect(log.lines.join('\n')).not.toContain(USER);
  });

  it('with a wrong password: a crash loop of restarts cannot multiply the logins, nothing secret is logged', async () => {
    const { ccu, t, log, make, stop } = await setup();
    ccu.rejectLogin = true;
    for (let r = 0; r < 30; r++) {
      const svc = make();
      await svc.start();
      await svc.ready;
      await stop(svc);
      t.add(60_000);
    }
    // the backoff survives the restarts: attempts at 0, 1, 3, 7, 15 and 25 minutes
    expect(ccu.logins).toBe(6);
    expect(ccu.logouts).toBe(0);
    const all = log.lines.join('\n');
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(USER);
    expect(all).not.toMatch(/sid\d+x/);
    expect(log.lines.some((l) => l.includes('CCU login rejected'))).toBe(true);
  });

  it('keeps a saved backoff for the same credentials and drops it for new ones', async () => {
    const { ccu, dir, t, make, stop } = await setup();
    ccu.rejectLogin = true;
    const a = make();
    await a.start();
    await a.ready;
    await stop(a);
    const state = () => readFile(join(dir, GAS_STATE_FILE), 'utf8').then((x) => JSON.parse(x));
    expect((await state()).auth.failures).toBe(1);
    expect(JSON.stringify(await state())).not.toContain(PASSWORD);
    ccu.rejectLogin = false;
    t.add(1000);
    const b = make();
    await b.start();
    await b.ready;
    expect(ccu.logins).toBe(1);
    t.add(60_000);
    await b.pollOnce();
    expect(ccu.logins).toBe(2);
    await stop(b);
    expect((await state()).auth).toBeUndefined();

    ccu.rejectLogin = true;
    const c = make();
    await c.start();
    await c.ready;
    await stop(c);
    expect((await state()).auth.failures).toBe(1);
    // the owner changes the password: another fingerprint, the next start tries at once
    const before = ccu.logins;
    const d = make(credentialKey(HOST, USER, `${PASSWORD}-new`));
    await d.start();
    await d.ready;
    expect(ccu.logins).toBe(before + 1);
    await stop(d);
  });
});

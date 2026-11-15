import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { dayStartMs } from '../../../src/gas/dates.js';
import { counterStep } from '../../../src/gas/counter.js';
import { BucketStore } from '../../../src/gas/store.js';
import { GasFactors } from '../../../src/gas/factors.js';
import { GasHistory } from '../../../src/gas/history.js';
import { GAS_LIMITS } from '../../../src/gas/service.js';
import { cleanup, clock, tempDir } from './helpers.js';

cleanup();

const T = Date.UTC(2026, 10, 15, 12, 0, 0);
const MIN = 60_000;

describe('gas counter steps', () => {
  it('allows 10 m³ per hour plus 0.05 m³ and drops more', () => {
    const prev = { counter: 100, at: T };
    expect(counterStep(prev, 100.2, T + MIN, GAS_LIMITS)).toEqual({
      delta: expect.closeTo(0.2, 9),
      reset: false,
      glitch: false,
    });
    // 10 m³/h x 1 min = 0.1667 + 0.05 slack
    expect(counterStep(prev, 100.21, T + MIN, GAS_LIMITS).glitch).toBe(false);
    expect(counterStep(prev, 100.22, T + MIN, GAS_LIMITS).glitch).toBe(true);
    expect(counterStep(prev, 109, T + 60 * MIN, GAS_LIMITS).glitch).toBe(false);
    expect(counterStep(prev, 111, T + 60 * MIN, GAS_LIMITS).glitch).toBe(true);
    // a clock that went backwards allows only the slack
    expect(counterStep(prev, 100.04, T - MIN, GAS_LIMITS).glitch).toBe(false);
    expect(counterStep(prev, 100.06, T - MIN, GAS_LIMITS).glitch).toBe(true);
  });

  it('holds a 0 below a positive baseline, but not a 0 baseline', () => {
    expect(counterStep({ counter: 100, at: T }, 0, T + MIN, GAS_LIMITS)).toEqual({
      delta: 0,
      reset: false,
      glitch: false,
      hold: true,
    });
    expect(counterStep({ counter: 0, at: T }, 0, T + MIN, GAS_LIMITS)).toEqual({
      delta: 0,
      reset: false,
      glitch: false,
    });
    // a genuine lower value is a reset: what was counted since the restart
    expect(counterStep({ counter: 100, at: T }, 0.03, T + MIN, GAS_LIMITS)).toEqual({
      delta: 0.03,
      reset: true,
      glitch: false,
    });
    // the first sample only sets the baseline
    expect(counterStep({}, 0, T, GAS_LIMITS)).toEqual({ delta: 0, reset: false, glitch: false });
  });

  it('is a reset below 1 m³ only; a lower value of 1 m³ or more is held as a glitch', () => {
    const prev = { counter: 800, at: T };
    expect(counterStep(prev, 0.2, T + MIN, GAS_LIMITS)).toEqual({ delta: 0.2, reset: true, glitch: false });
    expect(counterStep(prev, 0.99, T + 6 * MIN, GAS_LIMITS)).toEqual({ delta: 0.99, reset: true, glitch: false });
    expect(counterStep(prev, 1, T + MIN, GAS_LIMITS)).toEqual({ delta: 0, reset: false, glitch: true, hold: true });
    expect(counterStep(prev, 799.9, T + MIN, GAS_LIMITS)).toEqual({ delta: 0, reset: false, glitch: true, hold: true });
    // without the rule (a plain counter) any drop is a reset
    expect(counterStep(prev, 500, T + MIN, { maxPerHour: 1000, slack: 1 })).toEqual({ delta: 0, reset: true, glitch: true });
  });
});

describe('gas factors', () => {
  const f = new GasFactors({ calorificValue: 11.2, zNumber: 0.95 }, [
    { from: '2026-01-01', to: '2026-06-30', calorificValue: 11.5, zNumber: 0.96 },
    { from: '2026-10-01', calorificValue: 10, zNumber: 0.9 },
  ]);

  it('uses a period for its days (inclusive) and the defaults outside', () => {
    expect(f.forDay('2025-12-31')).toEqual({
      kwhPerM3: 10.64,
      calorificValue: 11.2,
      zNumber: 0.95,
      source: 'default',
    });
    expect(f.forDay('2026-01-01')).toMatchObject({ kwhPerM3: 11.04, source: 'period' });
    expect(f.forDay('2026-06-30').kwhPerM3).toBe(11.04);
    expect(f.forDay('2026-07-01').kwhPerM3).toBe(10.64);
    expect(f.forDay('2030-01-01')).toMatchObject({ kwhPerM3: 9, source: 'period' });
  });

  it("converts a day and sums months and years with each day's own factor", () => {
    expect(f.day('2026-03-02', 2.5)).toEqual({
      period: '2026-03-02',
      m3: 2.5,
      kwh: 27.6,
      factor: 11.04,
    });
    const days = [
      { date: '2026-06-30', m3: 1 },
      { date: '2026-07-01', m3: 1 },
      { date: '2026-07-02', m3: 0 },
      { date: '2026-10-05', m3: 2 },
      { date: '2025-12-31', m3: 3 },
    ];
    expect(f.sum(days, 7)).toEqual([
      { period: '2025-12', m3: 3, kwh: 31.92, factor: 10.64, factors: [10.64] },
      { period: '2026-06', m3: 1, kwh: 11.04, factor: 11.04, factors: [11.04] },
      { period: '2026-07', m3: 1, kwh: 10.64, factor: 10.64, factors: [10.64] },
      { period: '2026-10', m3: 2, kwh: 18, factor: 9, factors: [9] },
    ]);
    expect(f.sum(days, 4)).toEqual([
      { period: '2025', m3: 3, kwh: 31.92, factor: 10.64, factors: [10.64] },
      { period: '2026', m3: 4, kwh: 39.68, factor: 9.92, factors: [9, 10.64, 11.04] },
    ]);
    expect(f.sum([{ date: '2026-07-02', m3: 0 }], 7)).toEqual([
      { period: '2026-07', m3: 0, kwh: 0, factor: 10.64, factors: [10.64] },
    ]);
  });
});

describe('gas history', () => {
  const factors = new GasFactors({ calorificValue: 11.2, zNumber: 0.95 }, []);

  async function history(start: number, tz = 'Europe/Berlin') {
    const dir = await tempDir();
    const t = clock(start);
    const h = new GasHistory({
      dir,
      timeZone: tz,
      retentionDays: 90,
      factors,
      now: t.now,
      onWarn: () => undefined,
    });
    return { dir, t, h };
  }

  it('writes its own gas files', async () => {
    const { dir, h } = await history(T);
    h.record(T, 1, 0.5);
    await h.flush(true);
    const names = (await readdir(dir)).sort();
    expect(names).toEqual(['gas-days-2026-11.json', 'gas-live-2026-11-15.json']);
  });

  it('splits days at local midnight across the daylight saving changes (23 and 25 hour days)', async () => {
    const tz = 'Europe/Berlin';
    // 2026-03-29 has 23 hours, 2026-10-25 has 25 hours
    for (const [day, hours] of [
      ['2026-03-29', 23],
      ['2026-10-25', 25],
    ] as const) {
      const start = dayStartMs(day, tz);
      const end = dayStartMs(day === '2026-03-29' ? '2026-03-30' : '2026-10-26', tz);
      expect((end - start) / 3_600_000).toBe(hours);
      const { h } = await history(start - 10 * MIN, tz);
      // 0.01 m³ every 10 minutes from 10 minutes before midnight to 10 minutes after the next midnight
      for (let t = start - 10 * MIN; t <= end + 10 * MIN; t += 10 * MIN) h.record(t, 0.06, 0.01);
      const days = await h.days('2026-01-01', '2026-12-31');
      const prev = new Date(start - MIN).toISOString().slice(0, 10);
      expect(days.get(prev)).toBeCloseTo(0.01, 6);
      expect(days.get(day)).toBeCloseTo(hours * 6 * 0.01, 6);
      expect([...days.values()].reduce((a, b) => a + b, 0)).toBeCloseTo((hours * 6 + 3) * 0.01, 6);
      const rows = await h.liveRows(day);
      expect(rows[0]![0]).toBe(start / 1000);
      expect(rows.at(-1)![0]).toBe(end / 1000 - 600);
      expect(rows).toHaveLength(hours * 6);
    }
  });

  it('summarises today, yesterday and the month; a day with rows but no consumption is 0', async () => {
    const today = Date.UTC(2026, 10, 15, 11, 0, 0);
    const { t, h } = await history(Date.UTC(2026, 10, 1, 8, 0, 0));
    expect(await h.summary()).toEqual({
      factor: 10.64,
      todayM3: undefined,
      yesterdayM3: undefined,
      monthM3: undefined,
      monthKwh: undefined,
    });
    h.record(Date.UTC(2026, 9, 31, 8, 0, 0), 1, 2); // last month: not in the month
    h.record(Date.UTC(2026, 10, 1, 8, 0, 0), 1, 3);
    h.record(Date.UTC(2026, 10, 14, 8, 0, 0), 0, 0); // yesterday: polled, nothing used
    t.set(today);
    const s = await h.summary();
    expect(s).toEqual({
      factor: 10.64,
      todayM3: undefined,
      yesterdayM3: 0,
      monthM3: 3,
      monthKwh: 31.92,
    });
    h.record(today, 0.5, 0.25);
    expect(await h.summary()).toMatchObject({ todayM3: 0.25, monthM3: 3.25, monthKwh: 34.58 });
    // yesterday from the day totals when its rows are gone
    t.set(Date.UTC(2026, 10, 2, 9, 0, 0));
    expect((await h.summary()).yesterdayM3).toBe(3);
  });

  it('refuses unsafe or equal file prefixes', async () => {
    const dir = await tempDir();
    const opts = { dir, timeZone: 'UTC', retentionDays: 1 };
    expect(() => new BucketStore({ ...opts, livePrefix: '../x-' })).toThrow(/prefixes/);
    expect(() => new BucketStore({ ...opts, livePrefix: 'a-', daysPrefix: 'a-' })).toThrow(/differ/);
  });

  it('names the gas files in the warning about an unreadable file', async () => {
    const dir = await tempDir();
    const warn: string[] = [];
    const s = new BucketStore({
      dir,
      timeZone: 'UTC',
      retentionDays: 1,
      onWarn: (m) => warn.push(m),
      livePrefix: 'gas-live-',
      daysPrefix: 'gas-days-',
      label: 'gas',
    });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${dir}/gas-days-2026-11.json`, 'nope');
    await s.readDays('2026-11-01', '2026-11-30');
    expect(warn[0]).toMatch(/^A gas history file was unreadable/);
  });
});

describe('gas API helpers', () => {
  it('accepts only literal private or loopback addresses', async () => {
    const { isPrivateAddress } = await import('../../../src/gas/net.js');
    for (const a of ['10.0.0.1', '127.0.0.1', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.2']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '0.0.0.0', '::', '2001:db8::1', 'localhost', '', '::ffff:8.8.8.8']) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
  });

  it('serves /v1/hello only for a random looking token of 32+ characters and limits requests per peer', async () => {
    const { isHelloTokenStrong, HelloRateLimiter, MAX_TRACKED_PEERS, handleHello } = await import('../../../src/gas/hello.js');
    expect(isHelloTokenStrong('Zq3x9KpL2mN8vB4cR7tY1wE6uI0oPaSdFgHjKlXcVbN')).toBe(true);
    expect(isHelloTokenStrong('0123456789abcdef0123456789abcdef')).toBe(true);
    for (const weak of ['short', 'a'.repeat(40), 'abcabcabcabcabcabcabcabcabcabcabcabc', 'Zq3x9KpL2mN8vB4c R7tY1wE6uI0oPaSdFgHj', 'Zq3x9KpL2mN8vB4cR7tY1wE6uI0oPaaaaaaSdF']) {
      expect(isHelloTokenStrong(weak), weak).toBe(false);
    }
    const limiter = new HelloRateLimiter(2);
    expect([limiter.allow('p', 0), limiter.allow('p', 1), limiter.allow('p', 2)]).toEqual([true, true, false]);
    expect(limiter.allow('p', 60_001)).toBe(true);
    const many = new HelloRateLimiter();
    for (let i = 0; i < MAX_TRACKED_PEERS + 5; i++) many.allow(`peer${i}`, i < MAX_TRACKED_PEERS ? 0 : 70_000);
    expect(many.size).toBeLessThanOrEqual(MAX_TRACKED_PEERS);
    const full = new HelloRateLimiter();
    for (let i = 0; i < MAX_TRACKED_PEERS + 3; i++) full.allow(`peer${i}`, 0);
    expect(full.size).toBe(MAX_TRACKED_PEERS);
    const one = new HelloRateLimiter(1);
    one.allow('x', 0);
    expect(handleHello(new URLSearchParams('nonce=' + 'a'.repeat(43)), 't', 'h', one, 'x', 1)).toEqual({ status: 429, error: 'too many requests' });
    expect(handleHello(new URLSearchParams('nonce=a&nonce=b'), 't', 'h', new HelloRateLimiter(), 'x', 1).status).toBe(400);
  });
});

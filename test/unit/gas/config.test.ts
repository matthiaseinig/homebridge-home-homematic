import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALORIFIC_VALUE,
  DEFAULT_GAS_API_PORT,
  DEFAULT_Z_NUMBER,
  isCalendarDay,
  isGasDevice,
  MAX_FACTOR_PERIODS,
  MAX_METER_READINGS,
  normalizeGasConfig,
} from '../../../src/gas/config.js';
import { ConfigError, resolveConfig } from '../../../src/util/config.js';
import type { RawConfig } from '../../../src/types.js';
import { ADDRESS } from './helpers.js';

const base = { enabled: true, address: `${ADDRESS}:1` };
const norm = (extra: Record<string, unknown> = {}) => normalizeGasConfig({ ...base, ...extra });

describe('gas config', () => {
  it('is off by default and checks nothing then', () => {
    expect(normalizeGasConfig(undefined).config.enabled).toBe(false);
    expect(normalizeGasConfig({ enabled: 'yes', address: '!' })).toMatchObject({ config: { enabled: false }, errors: [] });
    expect(normalizeGasConfig([]).config.enabled).toBe(false);
  });

  it('applies the defaults', () => {
    const { config, errors } = norm();
    expect(errors).toEqual([]);
    expect(config).toMatchObject({
      enabled: true,
      name: 'Gas Meter',
      iface: 'BidCos-RF',
      address: ADDRESS,
      channel: 1,
      counterDatapoint: 'GAS_ENERGY_COUNTER',
      flowDatapoint: 'GAS_POWER',
      pollIntervalMs: 60_000,
      calorificValue: 11.2,
      zNumber: 0.95,
      factorPeriods: [],
      meterReadings: [],
    });
    expect(config.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(config.bridge).toBeUndefined();
    expect(config.api).toBeUndefined();
  });

  it('reads the channel address with or without interface and channel', () => {
    expect(norm({ address: `BidCos-RF.${ADDRESS}:2` }).config).toMatchObject({ iface: 'BidCos-RF', address: ADDRESS, channel: 2 });
    expect(norm({ address: `HmIP-RF.${ADDRESS}:3` }).config).toMatchObject({ iface: 'HmIP-RF', channel: 3 });
    expect(norm({ address: ADDRESS, channel: 4 }).config).toMatchObject({ channel: 4, iface: 'BidCos-RF' });
    expect(norm({ address: ADDRESS, interface: 'BidCos-Wired' }).config.iface).toBe('BidCos-Wired');
    expect(norm({ address: `${ADDRESS}:2`, channel: 2 }).config.channel).toBe(2);
    for (const extra of [
      { address: '' },
      { address: 'BAD ADDRESS' },
      { address: `Foo.${ADDRESS}:1` },
      { address: `${ADDRESS}:0` },
      { address: `${ADDRESS}:99` },
      { address: `${ADDRESS}:1`, channel: 2 },
      { address: `BidCos-RF.${ADDRESS}:1`, interface: 'HmIP-RF' },
      { interface: 'Bid Cos' },
      { channel: 0 },
      { channel: 51 },
      { channel: '1' },
    ]) {
      const r = norm(extra);
      expect(r.config.enabled, JSON.stringify(extra)).toBe(false);
      expect(r.errors[0]).toMatch(/the gas meter is off/);
    }
  });

  it('clamps the poll interval to 30 to 600 seconds', () => {
    expect(norm({ pollInterval: 5 }).config.pollIntervalMs).toBe(30_000);
    expect(norm({ pollInterval: 5000 }).config.pollIntervalMs).toBe(600_000);
    expect(norm({ pollInterval: 90.4 }).config.pollIntervalMs).toBe(90_000);
    expect(norm({ pollInterval: 'x' }).config.pollIntervalMs).toBe(60_000);
  });

  it('validates datapoint names, the name and the time zone', () => {
    const ok = norm({ datapoints: { counter: 'IEC_ENERGY_COUNTER', flow: 'IEC_POWER' }, name: ' Gas ', timeZone: 'Europe/Berlin' });
    expect(ok.config).toMatchObject({ counterDatapoint: 'IEC_ENERGY_COUNTER', flowDatapoint: 'IEC_POWER', name: 'Gas', timeZone: 'Europe/Berlin' });
    const bad = norm({ datapoints: { counter: 'gas counter', flow: 'X;Y' }, timeZone: 'Mars/Base' });
    expect(bad.config).toMatchObject({ counterDatapoint: 'GAS_ENERGY_COUNTER', flowDatapoint: 'GAS_POWER' });
    expect(bad.config.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(bad.errors).toHaveLength(3);
  });

  it('keeps the bridge choice and validates the API block', () => {
    expect(norm({ bridge: 'HomeMatic Keller' }).config.bridge).toBe('HomeMatic Keller');
    expect(norm({ api: { bindAddress: '192.168.1.10' } }).config.api).toEqual({ bindAddress: '192.168.1.10', port: DEFAULT_GAS_API_PORT });
    expect(norm({ api: { bindAddress: '127.0.0.1', port: 9000 } }).config.api).toEqual({ bindAddress: '127.0.0.1', port: 9000 });
    expect(norm({ api: { bindAddress: '' } }).config.api).toBeUndefined();
    for (const api of [{ bindAddress: '0.0.0.0' }, { bindAddress: 'homebridge.local' }, { bindAddress: '8.8.8.8' }, { bindAddress: '127.0.0.1', port: 80 }, { bindAddress: '127.0.0.1', port: 'x' }, 'on']) {
      const r = norm({ api });
      expect(r.config.enabled, JSON.stringify(api)).toBe(true);
      expect(r.config.api, JSON.stringify(api)).toBeUndefined();
      expect(r.errors[0]).toMatch(/gas API is off/);
    }
  });

  it('rejects factors outside 8 to 13 and 0.8 to 1.0 and keeps the defaults', () => {
    expect(norm({ calorificValue: 10.1, zNumber: 0.9 }).config).toMatchObject({ calorificValue: 10.1, zNumber: 0.9 });
    expect(norm({ calorificValue: 8, zNumber: 1 }).errors).toEqual([]);
    for (const extra of [{ calorificValue: 7.9 }, { calorificValue: 13.1 }, { calorificValue: '11' }, { zNumber: 0.79 }, { zNumber: 1.01 }]) {
      const r = norm(extra);
      expect(r.config.enabled).toBe(true);
      expect(r.config.calorificValue).toBe(DEFAULT_CALORIFIC_VALUE);
      expect(r.config.zNumber).toBe(DEFAULT_Z_NUMBER);
      expect(r.errors).toHaveLength(1);
    }
  });

  it('keeps valid, non-overlapping factor periods sorted, filling a missing value from the defaults', () => {
    const { config, errors } = norm({
      calorificValue: 11,
      factorPeriods: [
        { from: '2026-01-01', to: '2026-06-30', calorificValue: 11.4, zNumber: 0.96 },
        { from: '2025-01-01', to: '2025-12-31', zNumber: 0.94 },
        { from: '2026-06-30', calorificValue: 10 }, // overlaps the first on 2026-06-30
        { from: '2026-07-01', calorificValue: 10.5 },
        { from: '2026-08-01', calorificValue: 9 }, // overlaps the open ended one
        { from: '2026-02-30', calorificValue: 10 },
        { from: '2026-05-01', to: '2026-04-01', calorificValue: 10 },
        { from: '2027-01-01' },
        { from: '2027-01-01', calorificValue: 20 },
        'nope',
      ],
    });
    expect(config.factorPeriods).toEqual([
      { from: '2025-01-01', to: '2025-12-31', calorificValue: 11, zNumber: 0.94 },
      { from: '2026-01-01', to: '2026-06-30', calorificValue: 11.4, zNumber: 0.96 },
      { from: '2026-07-01', calorificValue: 10.5, zNumber: 0.95 },
    ]);
    expect(errors).toHaveLength(7);
    expect(errors.filter((e) => e.includes('overlaps'))).toHaveLength(2);
    expect(norm({ factorPeriods: {} }).errors).toEqual(['gas.factorPeriods must be a list, ignored']);
  });

  it('caps the number of periods and readings', () => {
    const periods = Array.from({ length: MAX_FACTOR_PERIODS + 5 }, (_, i) => ({
      from: `${2000 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`,
      to: `${2000 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-02`,
      zNumber: 0.9,
    }));
    const p = norm({ factorPeriods: periods });
    expect(p.config.factorPeriods).toHaveLength(MAX_FACTOR_PERIODS);
    expect(p.errors.at(-1)).toMatch(/only the first/);
    const readings = Array.from({ length: MAX_METER_READINGS + 1 }, (_, i) => ({
      date: '2026-01-01',
      time: `${String(Math.floor(i / 60) % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
      m3: i,
    }));
    const r = norm({ meterReadings: readings });
    expect(r.config.meterReadings).toHaveLength(MAX_METER_READINGS);
    expect(r.errors).toEqual([`gas.meterReadings: only the first ${MAX_METER_READINGS} entries are used`]);
  });

  it('keeps valid meter readings sorted by time, a reading without time at the end of its day', () => {
    const { config, errors } = norm({
      meterReadings: [
        { date: '2026-03-01', m3: 1200.5 },
        { date: '2026-03-01', time: '08:15', m3: 1190 },
        { date: '2026-01-01', time: '23:59', m3: 1000 },
        { date: '2026-03-01', m3: 1201 },
        { date: '2026-13-01', m3: 1 },
        { date: '2026-04-01', time: '24:00', m3: 1 },
        { date: '2026-04-01', m3: -1 },
        { date: '2026-04-01', m3: '5' },
        null,
      ],
    });
    expect(config.meterReadings).toEqual([
      { date: '2026-01-01', time: '23:59', m3: 1000 },
      { date: '2026-03-01', time: '08:15', m3: 1190 },
      { date: '2026-03-01', m3: 1200.5 },
    ]);
    expect(errors).toHaveLength(6);
    expect(norm({ meterReadings: 'x' }).errors).toEqual(['gas.meterReadings must be a list, ignored']);
  });

  it('knows real calendar days and the gas device in any address form', () => {
    expect(isCalendarDay('2024-02-29')).toBe(true);
    expect(isCalendarDay('2025-02-29')).toBe(false);
    expect(isCalendarDay('2025-4-3')).toBe(false);
    const gas = norm().config;
    for (const a of [`${ADDRESS}:1`, `BidCos-RF.${ADDRESS}:2`, ADDRESS.toLowerCase(), ` ${ADDRESS}:0 `]) {
      expect(isGasDevice(gas, a), a).toBe(true);
    }
    expect(isGasDevice(gas, 'OTHER00001:1')).toBe(false);
    expect(isGasDevice({ enabled: false, address: ADDRESS }, ADDRESS)).toBe(false);
  });
});

describe('gas block in the platform config', () => {
  const platform = (gas: unknown, more: Partial<RawConfig> = {}) => resolveConfig({ platform: 'HomematicHap', ccuIp: '127.0.0.1', gas, ...more } as RawConfig);

  it('never makes the block fail and reports problems as gas errors', () => {
    const off = platform(undefined);
    expect(off.gas.enabled).toBe(false);
    expect(off.gasErrors).toEqual([]);
    const bad = platform({ enabled: true, address: '' });
    expect(bad.gas.enabled).toBe(false);
    expect(bad.gasErrors[0]).toMatch(/gas.address/);
    expect(platform({ enabled: true, address: `${ADDRESS}:1` }).gas.enabled).toBe(true);
  });

  it('turns the gas API off when its port is the event server or a bridge port', () => {
    const r = platform({ enabled: true, address: `${ADDRESS}:1`, api: { bindAddress: '127.0.0.1', port: 9875 } });
    expect(r.gas.enabled).toBe(true);
    expect(r.gas.api).toBeUndefined();
    expect(r.gasErrors.at(-1)).toMatch(/9875 is used/);
    const host = resolveConfig({ platform: 'HomematicHap', ccuIp: '127.0.0.1', _bridge: { username: 'AA:BB:CC:DD:EE:01', port: 51000 },
      gas: { enabled: true, address: `${ADDRESS}:1`, api: { bindAddress: '127.0.0.1', port: 51000 } } } as unknown as RawConfig);
    expect(host.gas.api).toBeUndefined();
    const free = platform({ enabled: true, address: `${ADDRESS}:1`, api: { bindAddress: '127.0.0.1', port: 9000 } });
    expect(free.gas.api).toEqual({ bindAddress: '127.0.0.1', port: 9000 });
    expect(() => platform({ enabled: true }, { ccuIp: '' })).toThrow(ConfigError);
  });
});

import { describe, expect, it } from 'vitest';
import type { HAP } from 'homebridge';
import { CHARS, GAS_SERVICE, initialValue, sanitize, validMask } from '../../../src/gas/definitions.js';
import { GAS_ACCESSORY_SEED, GAS_SUBTYPE, GasMeterServices } from '../../../src/gas/hap.js';

const hap = (await import(process.env.HAP_NODEJS_PATH ?? '@homebridge/hap-nodejs')) as unknown as HAP;

const SUFFIX = '-2128-484C-867A-5E08EB2F0F54';

describe('gas meter HomeKit contract', () => {
  it('keeps the exact service and characteristic UUIDs of the app contract', () => {
    expect(GAS_SERVICE.uuid).toBe(`F7A10005${SUFFIX}`);
    expect(Object.fromEntries(Object.entries(CHARS).map(([k, d]) => [k, d.uuid]))).toEqual({
      ValidFields: `F7A00001${SUFFIX}`,
      LastUpdate: `F7A00002${SUFFIX}`,
      GasFlow: `F7A000A0${SUFFIX}`,
      GasMeterReading: `F7A000A1${SUFFIX}`,
      GasToday: `F7A000A2${SUFFIX}`,
      GasYesterday: `F7A000A3${SUFFIX}`,
      GasMonth: `F7A000A4${SUFFIX}`,
      GasMonthKwh: `F7A000A5${SUFFIX}`,
      GasFactor: `F7A000A6${SUFFIX}`,
      GasReachable: `F7A000A7${SUFFIX}`,
      GasLowBattery: `F7A000A8${SUFFIX}`,
    });
    expect(GAS_SERVICE.validBits).toEqual({
      GasFlow: 0, GasMeterReading: 1, GasToday: 2, GasYesterday: 3, GasMonth: 4,
      GasMonthKwh: 5, GasFactor: 6, GasReachable: 7, GasLowBattery: 8,
    });
  });

  it('rounds and clamps values, starts at 0 or false and masks known values', () => {
    expect(sanitize(CHARS.GasFlow, 1.23456)).toBe(1.235);
    expect(sanitize(CHARS.GasFlow, -0.0001)).toBe(0);
    expect(Object.is(sanitize(CHARS.GasFlow, -0.0001), -0)).toBe(false);
    expect(sanitize(CHARS.GasFlow, 5000)).toBe(1000);
    expect(sanitize(CHARS.GasFactor, 10.123456)).toBe(10.1235);
    expect(sanitize(CHARS.LastUpdate, 12.7)).toBe(13);
    expect(sanitize(CHARS.GasReachable, true)).toBe(true);
    expect(sanitize(CHARS.GasFlow, Number.NaN)).toBe(0);
    expect(initialValue(CHARS.GasReachable)).toBe(false);
    expect(initialValue(CHARS.GasToday)).toBe(0);
    expect(validMask({ GasFlow: 1, GasLowBattery: false })).toBe(1 + 256);
    expect(validMask({})).toBe(0);
  });

  it('builds a read-only Gas Meter service with fixed accessory information and no device address', () => {
    const acc = new hap.Accessory('Gas Meter', hap.uuid.generate(GAS_ACCESSORY_SEED));
    const svc = new GasMeterServices(hap, acc, 'Gas Meter');
    const gas = acc.services.find((s) => s.UUID === GAS_SERVICE.uuid)!;
    expect(gas.subtype).toBe(GAS_SUBTYPE);
    for (const key of GAS_SERVICE.chars) {
      const c = gas.characteristics.find((x) => x.UUID === CHARS[key].uuid);
      expect(c, key).toBeDefined();
      expect(c!.props.perms.sort()).toEqual([hap.Perms.NOTIFY, hap.Perms.PAIRED_READ].sort());
    }
    const info = acc.getService(hap.Service.AccessoryInformation)!;
    expect(info.getCharacteristic(hap.Characteristic.Manufacturer).value).toBe('HomeMatic HAP');
    expect(info.getCharacteristic(hap.Characteristic.Model).value).toBe('Gas Meter');
    expect(info.getCharacteristic(hap.Characteristic.SerialNumber).value).toBe('gas-meter');

    svc.apply({ GasMeterReading: 4321.98765, GasReachable: true, LastUpdate: 1_800_000_000 });
    const value = (key: keyof typeof CHARS) => gas.characteristics.find((x) => x.UUID === CHARS[key].uuid)!.value;
    expect(value('GasMeterReading')).toBe(4321.988);
    expect(value('ValidFields')).toBe(2 + 128);
    // unknown values leave the last one in place and clear its bit
    svc.apply({ GasReachable: true });
    expect(value('GasMeterReading')).toBe(4321.988);
    expect(value('ValidFields')).toBe(128);
    expect(value('LastUpdate')).toBe(1_800_000_000);

    // a second instance on the same accessory reuses the service
    new GasMeterServices(hap, acc, 'Gas');
    expect(acc.services.filter((s) => s.UUID === GAS_SERVICE.uuid)).toHaveLength(1);
    expect(gas.getCharacteristic(hap.Characteristic.Name).value).toBe('Gas');
  });

  it('adds missing characteristics to a service restored from the cache', () => {
    const acc = new hap.Accessory('Gas Meter', hap.uuid.generate('restored'));
    const plain = new hap.Service('Gas Meter', GAS_SERVICE.uuid, GAS_SUBTYPE);
    acc.addService(plain);
    new GasMeterServices(hap, acc, 'Gas Meter');
    expect(plain.characteristics.filter((c) => c.UUID.startsWith('F7A0'))).toHaveLength(GAS_SERVICE.chars.length);
  });
});

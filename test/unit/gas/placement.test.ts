import { describe, expect, it } from 'vitest';
import { gasMappingConflict, resolveGasPlacement } from '../../../src/gas/placement.js';
import type { MultiBridgeConfig, MultiBridgeEntry } from '../../../src/types.js';
import { ADDRESS } from './helpers.js';

const bridge = (name: string, enabled = true): MultiBridgeEntry => ({
  name, enabled, username: 'AA:BB:CC:DD:EE:01', pincode: '111-22-333', port: 51001, category: 2,
  newIdentity: true, hapHomematicIdentity: false, channels: [], variables: [], programs: [],
});
const multi = (...bridges: MultiBridgeEntry[]): MultiBridgeConfig => ({ advertiser: 'ciao', retrySeconds: 30, bridges });

describe('gas meter placement', () => {
  it('defaults to the Keller bridge if there is an enabled one, else the host bridge', () => {
    expect(resolveGasPlacement(undefined, undefined)).toEqual({ placement: { kind: 'host' } });
    expect(resolveGasPlacement(undefined, multi(bridge('HomeMatic Flur'), bridge('HomeMatic Keller'))))
      .toEqual({ placement: { kind: 'bridge', name: 'HomeMatic Keller' } });
    expect(resolveGasPlacement(undefined, multi(bridge('HomeMatic Flur'), bridge('HomeMatic Keller', false))))
      .toEqual({ placement: { kind: 'host' } });
  });

  it('takes host or the name of an enabled bridge and refuses anything else', () => {
    const m = multi(bridge('HomeMatic Flur'), bridge('HomeMatic Keller'), bridge('HomeMatic Alt', false));
    expect(resolveGasPlacement('host', m)).toEqual({ placement: { kind: 'host' } });
    expect(resolveGasPlacement('HOST', undefined)).toEqual({ placement: { kind: 'host' } });
    expect(resolveGasPlacement('HomeMatic Flur', m)).toEqual({ placement: { kind: 'bridge', name: 'HomeMatic Flur' } });
    for (const name of ['HomeMatic Alt', 'homematic flur', 'Nope']) {
      expect(resolveGasPlacement(name, m)).toMatchObject({ error: expect.stringMatching(/not published/) });
    }
    expect(resolveGasPlacement('HomeMatic Flur', undefined)).toHaveProperty('error');
  });
});

describe('gas meter mapping guard', () => {
  const gas = { enabled: true, address: ADDRESS };

  it('never maps the gas device, in any address form and with any service', () => {
    for (const address of [`${ADDRESS}:1`, `BidCos-RF.${ADDRESS}:1`, `${ADDRESS.toLowerCase()}:0`]) {
      for (const service of ['PowerMeterAccessory', 'SwitchAccessory']) {
        expect(gasMappingConflict(gas, { address, service }), `${address} ${service}`).toMatch(/gas meter device/);
      }
    }
  });

  it('never publishes a POWERMETER_IGL channel as a power meter Outlet in gas mode', () => {
    expect(gasMappingConflict(gas, { address: 'OTHER00001:1', service: 'PowerMeterAccessory' }, 'POWERMETER_IGL')).toMatch(/Outlet/);
    expect(gasMappingConflict(gas, { address: 'OTHER00001:1', service: 'PowerMeterAccessory' }, 'POWERMETER')).toBeUndefined();
    expect(gasMappingConflict(gas, { address: 'OTHER00001:1', service: 'TemperatureAccessory' }, 'POWERMETER_IGL')).toBeUndefined();
  });

  it('changes nothing without the gas meter', () => {
    expect(gasMappingConflict(undefined, { address: `${ADDRESS}:1`, service: 'PowerMeterAccessory' }, 'POWERMETER_IGL')).toBeUndefined();
    expect(gasMappingConflict({ enabled: false, address: '' }, { address: `${ADDRESS}:1`, service: 'PowerMeterAccessory' }, 'POWERMETER_IGL')).toBeUndefined();
  });
});

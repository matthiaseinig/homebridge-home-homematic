/**
 * Every published channel, variable and program accessory carries its stable
 * key as the Accessory Information SerialNumber, so HomeKit does not show
 * the Homebridge default serial. Keys are unique per bridge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { API, HAP } from 'homebridge';
import { APIEvent } from 'homebridge';
import type { CcuClient } from '../../src/ccu/CcuClient.js';
import { buildBridge } from '../../src/multiBridge/bridgeBuilder.js';
import { HomematicPlatform } from '../../src/platform.js';
import { PLUGIN_VERSION } from '../../src/settings.js';
import type { CcuDevice, CcuVariable, MultiBridgeEntry } from '../../src/types.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeHapStub, makeLog } from '../helpers/hapStub.js';

const hap = (await import(process.env.HAP_NODEJS_PATH ?? '@homebridge/hap-nodejs')) as unknown as HAP;

const DOOR = '0000AAAAAAAAAA:3';
const WINDOW = '0000BBBBBBBBBB:1';
const LAMP = '0000CCCCCCCCCC:2';
const DEVICES: CcuDevice[] = [
  { address: '0000AAAAAAAAAA', type: 'HmIPW-DRS4', name: 'relay', interface: 'HmIP-RF', channels: [
    { address: DOOR, index: 3, type: 'SWITCH_VIRTUAL_RECEIVER', name: 'Relay 3' },
  ] },
  { address: '0000BBBBBBBBBB', type: 'HmIP-SWDM', name: 'window', interface: 'HmIP-RF', channels: [
    { address: WINDOW, index: 1, type: 'SHUTTER_CONTACT', name: 'Window ch' },
  ] },
  { address: '0000CCCCCCCCCC', type: 'HmIPW-DRS8', name: 'lamp', interface: 'HmIP-RF', channels: [
    { address: LAMP, index: 2, type: 'SWITCH_VIRTUAL_RECEIVER', name: 'Lamp ch' },
  ] },
];
const VARIABLES: CcuVariable[] = [{ name: 'Var_Soc', id: '1234', valuetype: 4, subtype: 0, value: 50 }];

function entry(over: Partial<MultiBridgeEntry> = {}): MultiBridgeEntry {
  return {
    name: 'Bridge A', enabled: true, username: 'CC:22:3D:E3:CE:0A', pincode: '111-22-333', setupID: 'AB12',
    port: 51001, bridgeUuid: '880e3bf1-3038-414d-ae33-b2864d088626', category: 2, newIdentity: false,
    hapHomematicIdentity: true, channels: [], variables: [], programs: [], ...over,
  };
}

function fakeCcu(): unknown {
  return {
    registerListener: vi.fn(() => () => undefined),
    getValue: vi.fn(() => Promise.reject(new Error('offline'))),
    setValue: vi.fn(async () => undefined),
    api: { getVariable: vi.fn(() => Promise.reject(new Error('offline'))), setVariable: vi.fn(() => Promise.reject(new Error('offline'))) },
  };
}

describe('accessory SerialNumber (bridge builder)', () => {
  it('equals the stable key of each accessory and the keys are unique', () => {
    const built = buildBridge(
      { hap, ccu: fakeCcu() as CcuClient, log: new PrefixedLogger(makeLog(), 't'), version: PLUGIN_VERSION },
      entry({
        channels: [
          { address: DOOR, service: 'DoorOpenerAccessory', name: 'Door', uuidSeed: 'SWITCH_VIRTUAL_RECEIVER:Door' },
          { address: WINDOW, service: 'ContactAccessory', name: 'Window' },
          { address: LAMP, service: 'SwitchAccessory', name: 'Lamp' },
        ],
        variables: [{ name: 'Var_Soc', service: 'VariableNumericSensorAccessory' }],
        programs: [{ name: 'Morning' }],
      }),
      { devices: DEVICES, variables: VARIABLES },
    );
    const serials = built.bridge.bridgedAccessories.map(
      (a) => a.getService(hap.Service.AccessoryInformation)!.getCharacteristic(hap.Characteristic.SerialNumber).value,
    );
    expect(serials).toEqual([DOOR, WINDOW, LAMP, 'var:1234', 'prog:Morning']);
    expect(new Set(serials).size).toBe(serials.length);
    built.handlers.forEach((h) => h.dispose?.());
  });

  it('does not change accessory UUIDs', () => {
    const built = buildBridge(
      { hap, ccu: fakeCcu() as CcuClient, log: new PrefixedLogger(makeLog(), 't'), version: PLUGIN_VERSION },
      entry({ channels: [{ address: DOOR, service: 'DoorOpenerAccessory', name: 'Door', uuidSeed: 'SWITCH_VIRTUAL_RECEIVER:Door' }] }),
      { devices: DEVICES, variables: VARIABLES },
    );
    expect(built.accessories[0]?.uuid).toBe(hap.uuid.generate('SWITCH_VIRTUAL_RECEIVER:Door'));
    built.handlers.forEach((h) => h.dispose?.());
  });
});

describe('accessory SerialNumber (single bridge platform)', () => {
  let tmpDir = '';
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-serial-'));
  });

  it('sets the key on channel, variable and program accessories', async () => {
    const stubHap = makeHapStub();
    (stubHap as unknown as { uuid: { generate(s: string): string } }).uuid = { generate: (s: string) => `uuid:${s}` };
    const serials = new Map<string, unknown>();
    const api = Object.assign(new EventEmitter(), {
      hap: stubHap,
      user: { storagePath: () => tmpDir },
      registerPlatform: vi.fn(),
      registerPlatformAccessories: vi.fn(),
      unregisterPlatformAccessories: vi.fn(),
      updatePlatformAccessories: vi.fn(),
      platformAccessory: class {
        services: unknown[] = [];
        context: Record<string, unknown> = {};
        constructor(public displayName: string, public UUID: string) {}
        getService = vi.fn((svc: { UUID?: string }) =>
          svc === (stubHap.Service as unknown as Record<string, unknown>).AccessoryInformation
            ? { setCharacteristic: (_c: unknown, v: unknown) => { serials.set(this.UUID, v); } }
            : undefined);
        getServiceById = vi.fn(() => undefined);
        addService = vi.fn((s: unknown) => { this.services.push(s); return s; });
      },
    });
    const platform = new HomematicPlatform(makeLog(), {
      platform: 'HomematicHap', ccuIp: '127.0.0.1',
      channels: [{ address: 'HmIP.0:1', service: 'SwitchAccessory' }],
      variables: [{ name: 'V1' }],
      programs: [{ name: 'P1' }],
    }, api as unknown as API);
    const ccu = platform.getCcu()!;
    vi.spyOn(ccu, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu, 'listDevices').mockResolvedValue([
      { address: 'HmIP.0', type: 'X', name: 'D', interface: 'HmIP-RF', channels: [{ address: 'HmIP.0:1', index: 1, type: 'SWITCH', name: 'C' }] },
    ]);
    vi.spyOn(ccu, 'listVariables').mockResolvedValue([{ id: '77', name: 'V1', valuetype: 2, subtype: 0, value: false } as CcuVariable]);
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    const values = [...serials.values()];
    expect(values).toEqual(expect.arrayContaining(['HmIP.0:1', 'var:77', 'prog:P1']));
    expect(new Set(values).size).toBe(values.length);
  });
});

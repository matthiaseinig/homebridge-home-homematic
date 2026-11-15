/**
 * The gas meter in the platform: placement on the host bridge or a
 * multi-bridge, the mapping guard, and polling that does not wait for the
 * XML-RPC event subscriptions. The CCU's JSON-RPC answers are faked on the
 * shared client; HAP is the real HAP-NodeJS.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { format } from 'node:util';
import type { API, HAP, PlatformAccessory } from 'homebridge';
import { HomematicPlatform } from '../../../src/platform.js';
import { CcuClient } from '../../../src/ccu/CcuClient.js';
import { CcuJsonRpcClient } from '../../../src/ccu/CcuJsonRpcClient.js';
import { GAS_SERVICE } from '../../../src/gas/definitions.js';
import { GAS_ACCESSORY_SEED } from '../../../src/gas/hap.js';
import type { CcuDevice } from '../../../src/types.js';
import { makeLog } from '../../helpers/hapStub.js';
import { ADDRESS } from './helpers.js';

const hap = (await import(process.env.HAP_NODEJS_PATH ?? '@homebridge/hap-nodejs')) as unknown as HAP;

const LAMP = '0000CCCCCCCCCC:2';
const IGL = 'OTHER00001:1';
const DEVICES: CcuDevice[] = [
  { address: '0000CCCCCCCCCC', type: 'HmIPW-DRS8', name: 'lamp', interface: 'HmIP-RF',
    channels: [{ address: LAMP, index: 2, type: 'SWITCH_VIRTUAL_RECEIVER', name: 'Lamp ch' }] },
  { address: ADDRESS, type: 'HM-ES-TX-WM', name: 'gas', interface: 'BidCos-RF',
    channels: [{ address: `${ADDRESS}:1`, index: 1, type: 'POWERMETER_IGL', name: 'Gas ch' }] },
  { address: 'OTHER00001', type: 'HM-ES-TX-WM', name: 'igl', interface: 'BidCos-RF',
    channels: [{ address: IGL, index: 1, type: 'POWERMETER_IGL', name: 'Igl ch' }] },
];

class FakePlatformAccessory extends hap.Accessory {
  context: Record<string, unknown> = {};
}

class FakeApi extends EventEmitter {
  hap = hap;
  platformAccessory = FakePlatformAccessory as unknown as API['platformAccessory'];
  registered: PlatformAccessory[] = [];
  constructor(private readonly dir: string) {
    super();
  }
  user = { storagePath: () => this.dir, persistPath: () => this.dir };
  registerPlatformAccessories = vi.fn((_p: string, _n: string, accs: PlatformAccessory[]) => {
    this.registered.push(...accs);
  });
  unregisterPlatformAccessories = vi.fn();
  updatePlatformAccessories = vi.fn();
}

const flush = async (rounds = 30): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 5));
};

/** JSON-RPC answers of a reachable gas meter at 1234.5 m³; records the methods. */
function fakeJsonRpc(): string[] {
  const methods: string[] = [];
  vi.spyOn(CcuJsonRpcClient.prototype, 'call').mockImplementation(async (method: string, params?: Record<string, unknown>) => {
    methods.push(method);
    if (method === 'Interface.getValue') return (params?.valueKey === 'LOWBAT' ? '0' : false) as never;
    if (method === 'Interface.getParamset') return { GAS_ENERGY_COUNTER: '1234.500000', GAS_POWER: '0.300000' } as never;
    if (method === 'Interface.getParamsetDescription') return [{ NAME: 'GAS_ENERGY_COUNTER', UNIT: 'm3' }, { NAME: 'GAS_POWER', UNIT: 'm3' }] as never;
    throw new Error(`unexpected ${method}`);
  });
  return methods;
}

const gasBlock = (extra: Record<string, unknown> = {}) => ({ enabled: true, address: `BidCos-RF.${ADDRESS}:1`, ...extra });
const lines = (log: ReturnType<typeof makeLog>): string[] =>
  (['info', 'warn', 'error', 'debug', 'success'] as const).flatMap((l) => vi.mocked(log[l]).mock.calls.map((c) => format(...(c as [string, ...unknown[]]))));
const gasService = (acc: { services: Array<{ UUID: string }> }) => acc.services.find((s) => s.UUID === GAS_SERVICE.uuid);

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-homematic-gas-platform-'));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('gas meter on the host bridge', () => {
  it('registers the gas accessory and polls although the XML-RPC subscription fails', async () => {
    const dir = await tmp();
    const methods = fakeJsonRpc();
    vi.spyOn(CcuClient.prototype, 'start').mockRejectedValue(new Error('connect ECONNREFUSED (HmIP-RF event port firewalled)'));
    const stop = vi.spyOn(CcuClient.prototype, 'stop').mockResolvedValue();
    const api = new FakeApi(dir);
    const log = makeLog();
    new HomematicPlatform(log, { platform: 'HomematicHap', ccuIp: '127.0.0.1', gas: gasBlock() }, api as unknown as API);
    api.emit('didFinishLaunching');
    await flush();
    const acc = api.registered.find((a) => a.UUID === hap.uuid.generate(GAS_ACCESSORY_SEED));
    expect(acc).toBeDefined();
    const svc = gasService(acc as never) as never as { characteristics: Array<{ UUID: string; value: unknown }> };
    expect(svc).toBeDefined();
    const reading = svc.characteristics.find((c) => c.UUID.startsWith('F7A000A1'))!;
    expect(reading.value).toBe(1234.5);
    expect(methods).toContain('Interface.getParamset');
    expect(methods.every((m) => m.startsWith('Interface.get'))).toBe(true);
    api.emit('shutdown');
    await flush();
    expect(stop).toHaveBeenCalled();
    // the gas history lives in the plugin's storage folder
    expect(await fs.readdir(path.join(dir, 'homebridge-homematic-hap', 'gas'))).toContain('gas-state.json');
  });

  it('skips a mapping of the gas device and a POWERMETER_IGL power meter, without logging the gas address', async () => {
    const dir = await tmp();
    fakeJsonRpc();
    vi.spyOn(CcuClient.prototype, 'start').mockResolvedValue();
    vi.spyOn(CcuClient.prototype, 'stop').mockResolvedValue();
    vi.spyOn(CcuClient.prototype, 'listDevices').mockResolvedValue(DEVICES);
    vi.spyOn(CcuClient.prototype, 'getValue').mockRejectedValue(new Error('offline'));
    vi.spyOn(CcuClient.prototype, 'registerListener').mockReturnValue(() => undefined);
    const api = new FakeApi(dir);
    const log = makeLog();
    new HomematicPlatform(log, {
      platform: 'HomematicHap',
      ccuIp: '127.0.0.1',
      gas: gasBlock(),
      channels: [
        { address: `${ADDRESS}:1`, service: 'PowerMeterAccessory', name: 'Gas as outlet' },
        { address: IGL, service: 'PowerMeterAccessory', name: 'Igl as outlet' },
        { address: LAMP, service: 'SwitchAccessory', name: 'Lamp' },
      ],
    }, api as unknown as API);
    api.emit('didFinishLaunching');
    await flush();
    const names = api.registered.map((a) => a.displayName);
    expect(names).toEqual(['Gas Meter', 'Lamp']);
    expect(api.registered.some((a) => a.services.some((s) => s.UUID === hap.Service.Outlet.UUID))).toBe(false);
    const all = lines(log).join('\n');
    expect(all).not.toContain(ADDRESS);
    expect(all).toMatch(/gas meter device/);
    expect(all).toMatch(/POWERMETER_IGL channel is not published/);
    api.emit('shutdown');
    await flush();
  });

  it('removes a cached gas accessory when the gas meter is turned off', async () => {
    const dir = await tmp();
    vi.spyOn(CcuClient.prototype, 'start').mockResolvedValue();
    vi.spyOn(CcuClient.prototype, 'stop').mockResolvedValue();
    const api = new FakeApi(dir);
    const platform = new HomematicPlatform(makeLog(), { platform: 'HomematicHap', ccuIp: '127.0.0.1' }, api as unknown as API);
    const cached = new FakePlatformAccessory('Gas Meter', hap.uuid.generate(GAS_ACCESSORY_SEED));
    cached.context = { kind: 'gas' };
    platform.configureAccessory(cached as unknown as PlatformAccessory);
    api.emit('didFinishLaunching');
    await flush();
    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(expect.anything(), expect.anything(), [cached]);
  });

  it('logs gas config errors and a bridge name without multi-bridges, and still runs the rest', async () => {
    const dir = await tmp();
    fakeJsonRpc();
    vi.spyOn(CcuClient.prototype, 'start').mockResolvedValue();
    vi.spyOn(CcuClient.prototype, 'stop').mockResolvedValue();
    const api = new FakeApi(dir);
    const log = makeLog();
    new HomematicPlatform(log, { platform: 'HomematicHap', ccuIp: '127.0.0.1', gas: gasBlock({ bridge: 'HomeMatic Keller', zNumber: 2 }) }, api as unknown as API);
    api.emit('didFinishLaunching');
    await flush();
    const errors = vi.mocked(log.error).mock.calls.map((c) => String(c[0]) + String(c[1] ?? ''));
    expect(errors.some((e) => e.includes('gas.zNumber'))).toBe(true);
    expect(errors.some((e) => e.includes('gas.bridge'))).toBe(true);
    expect(api.registered).toHaveLength(0);
    api.emit('shutdown');
    await flush();
  });
});

describe('gas meter on a multi-bridge', () => {
  const bridges = [
    { name: 'HomeMatic Flur', enabled: true, newIdentity: true, username: 'CC:22:3D:E3:CE:0A', pincode: '111-22-333', port: 51001,
      channels: [{ address: LAMP, service: 'SwitchAccessory', name: 'Flur Licht' }] },
    { name: 'HomeMatic Keller', enabled: true, newIdentity: true, username: 'CC:22:3D:E3:CE:0B', pincode: '111-22-334', port: 51002,
      channels: [{ address: `${ADDRESS}:1`, service: 'PowerMeterAccessory', name: 'Gaszaehler' }, { address: IGL, service: 'PowerMeterAccessory', name: 'Igl' }] },
  ];

  function mockCcu(live = true) {
    vi.spyOn(CcuClient.prototype, 'start').mockResolvedValue();
    vi.spyOn(CcuClient.prototype, 'stop').mockResolvedValue();
    vi.spyOn(CcuClient.prototype, 'isLive').mockReturnValue(live);
    vi.spyOn(CcuClient.prototype, 'listDevices').mockResolvedValue(DEVICES);
    vi.spyOn(CcuClient.prototype, 'getValue').mockRejectedValue(new Error('offline'));
    vi.spyOn(CcuClient.prototype, 'registerListener').mockReturnValue(() => undefined);
  }

  it('puts the gas accessory on the Keller bridge by default, never the gas device as an Outlet', async () => {
    const dir = await tmp();
    fakeJsonRpc();
    mockCcu();
    const published: Array<{ name: string; accessories: Array<{ UUID: string; displayName: string; services: Array<{ UUID: string }> }> }> = [];
    vi.spyOn(hap.Bridge.prototype, 'publish').mockImplementation(async function (this: InstanceType<HAP['Bridge']>) {
      published.push({ name: this.displayName, accessories: this.bridgedAccessories });
    } as never);
    vi.spyOn(hap.Accessory.prototype, 'unpublish').mockResolvedValue(undefined as never);
    const api = new FakeApi(dir);
    const log = makeLog();
    const platform = new HomematicPlatform(log, {
      platform: 'HomematicHap', ccuIp: '127.0.0.1', eventServer: { port: 51875 }, gas: gasBlock(), multiBridge: { bridges },
    }, api as unknown as API);
    const cachedGas = new FakePlatformAccessory('Gas Meter', hap.uuid.generate(GAS_ACCESSORY_SEED));
    cachedGas.context = { kind: 'gas' };
    platform.configureAccessory(cachedGas as unknown as PlatformAccessory);
    api.emit('didFinishLaunching');
    await flush(60);
    const keller = published.find((b) => b.name === 'HomeMatic Keller')!;
    const flur = published.find((b) => b.name === 'HomeMatic Flur')!;
    expect(keller.accessories.map((a) => a.displayName)).toEqual(['Gas Meter']);
    expect(gasService(keller.accessories[0]!)).toBeDefined();
    expect(flur.accessories.some((a) => gasService(a))).toBe(false);
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
    // the host copy of the accessory moved to the Keller bridge
    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(expect.anything(), expect.anything(), [cachedGas]);
    expect(lines(log).join('\n')).not.toContain(ADDRESS);
    api.emit('shutdown');
    await flush();
  });

  it('keeps the gas accessory on the host bridge with gas.bridge "host"', async () => {
    const dir = await tmp();
    fakeJsonRpc();
    mockCcu();
    vi.spyOn(hap.Bridge.prototype, 'publish').mockResolvedValue(undefined as never);
    vi.spyOn(hap.Accessory.prototype, 'unpublish').mockResolvedValue(undefined as never);
    const api = new FakeApi(dir);
    const log = makeLog();
    new HomematicPlatform(log, {
      platform: 'HomematicHap', ccuIp: '127.0.0.1', eventServer: { port: 51875 }, gas: gasBlock({ bridge: 'host' }), multiBridge: { bridges },
    }, api as unknown as API);
    api.emit('didFinishLaunching');
    await flush(60);
    expect(api.registered.map((a) => a.UUID)).toEqual([hap.uuid.generate(GAS_ACCESSORY_SEED)]);
    expect(lines(log).some((l) => l.includes('ignores'))).toBe(false);
    api.emit('shutdown');
    await flush();
  });

  it('polls the gas meter while no bridge can be published (event ports firewalled)', async () => {
    const dir = await tmp();
    const methods = fakeJsonRpc();
    mockCcu(false);
    const publish = vi.spyOn(hap.Bridge.prototype, 'publish').mockResolvedValue(undefined as never);
    const api = new FakeApi(dir);
    new HomematicPlatform(makeLog(), {
      platform: 'HomematicHap', ccuIp: '127.0.0.1', eventServer: { port: 51875 }, gas: gasBlock(), multiBridge: { retrySeconds: 5, bridges },
    }, api as unknown as API);
    api.emit('didFinishLaunching');
    await flush();
    expect(publish).not.toHaveBeenCalled();
    expect(methods).toContain('Interface.getParamset');
    api.emit('shutdown');
    await flush();
  });
});

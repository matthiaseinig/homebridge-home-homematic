import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { HAP } from 'homebridge';
import { CcuClient } from '../../../src/ccu/CcuClient.js';
import { CcuJsonRpcClient } from '../../../src/ccu/CcuJsonRpcClient.js';
import { buildBridge } from '../../../src/multiBridge/bridgeBuilder.js';
import { resolveConfig } from '../../../src/util/config.js';
import { PrefixedLogger } from '../../../src/util/logger.js';
import type { MultiBridgeEntry, RawConfig } from '../../../src/types.js';
import { makeLog } from '../../helpers/hapStub.js';
import { ADDRESS } from './helpers.js';

const hap = (await import(process.env.HAP_NODEJS_PATH ?? '@homebridge/hap-nodejs')) as unknown as HAP;

describe('CCU client shutdown', () => {
  it('logs the JSON-RPC session out on stop, also after a failed start', async () => {
    const ccu = new CcuClient({ config: resolveConfig({ platform: 'HomematicHap', ccuIp: '127.0.0.1' } as RawConfig), log: new PrefixedLogger(makeLog(), 'ccu') });
    const logout = vi.spyOn(ccu.api, 'logout').mockResolvedValue();
    await ccu.stop();
    expect(logout).toHaveBeenCalledTimes(1);
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined as never);
    vi.spyOn(ccu.eventServer, 'stop').mockResolvedValue(undefined as never);
    vi.spyOn(ccu.api, 'listInterfaces').mockResolvedValue([]);
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([]);
    await ccu.start();
    await ccu.stop();
    expect(logout).toHaveBeenCalledTimes(2);
  });
});

describe('bridge builder with the gas meter', () => {
  const entry: MultiBridgeEntry = {
    name: 'HomeMatic Keller', enabled: true, username: 'CC:22:3D:E3:CE:0B', pincode: '111-22-334', port: 51002, category: 2,
    newIdentity: true, hapHomematicIdentity: false,
    channels: [{ address: `BidCos-RF.${ADDRESS}:1`, service: 'PowerMeterAccessory' }], variables: [], programs: [],
  };

  it('adds the extra accessory once and lists the gas device mapping as skipped without its address', () => {
    const log = makeLog();
    const extra = (): InstanceType<HAP['Accessory']>[] => [new hap.Accessory('Gas Meter', hap.uuid.generate('x')), new hap.Accessory('Gas Meter', hap.uuid.generate('x'))];
    const built = buildBridge({
      hap, ccu: {} as CcuClient, log: new PrefixedLogger(log, 'multi'), version: '1.7.0',
      gas: { enabled: true, address: ADDRESS }, extraAccessories: extra,
    }, entry, { devices: [], variables: [] });
    expect(built.accessories.map((a) => a.kind)).toEqual(['gas']);
    expect(built.skipped.map((s) => s.kind)).toEqual(['channel', 'gas']);
    expect(built.skipped[0]!.id).toBe('gas meter device');
    expect(built.skipped[1]!.reason).toMatch(/already used/);
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain(ADDRESS);
  });
});

describe('shared JSON-RPC client answers', () => {
  it('rejects a JSON answer that is no object as malformed', async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('null');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const api = new CcuJsonRpcClient({ host: '127.0.0.1', port, log: new PrefixedLogger(makeLog(), 'api') });
      await expect(api.call('Interface.getValue')).rejects.toMatchObject({ kind: 'protocol', message: expect.stringMatching(/malformed/) });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

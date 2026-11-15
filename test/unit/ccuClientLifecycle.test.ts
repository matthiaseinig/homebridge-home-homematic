/**
 * Covers start/stop/list-* and watchdog branches of CcuClient by stubbing
 * the JSON-RPC client and the event server so we never open sockets.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import { RpcClient } from '../../src/ccu/RpcClient.js';
import { TLS_CREDENTIALS_REFUSED } from '../../src/ccu/ccuTls.js';
import { resolveConfig } from '../../src/util/config.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function makeCcu(): CcuClient {
  const config = resolveConfig({
    platform: 'HomematicHap',
    ccuIp: '127.0.0.1',
    eventServer: { host: '127.0.0.1', port: 9876, watchdogSeconds: 60 },
    interfaces: { bidcosRf: false, hmIpRf: false, bidcosWired: false, virtualDevices: false, cuxd: false },
  });
  return new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'lc') });
}

describe('CcuClient list*()', () => {
  it('listDevices delegates to the JSON-RPC client', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([
      { address: 'HmIP.000123', name: 'X', type: 'T', interface: 'HmIP-RF', channels: [] },
    ]);
    const devices = await ccu.listDevices();
    expect(devices).toHaveLength(1);
  });

  it('listVariables delegates to the JSON-RPC client', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listVariables').mockResolvedValue([
      { id: '1', name: 'V', valuetype: 2, subtype: 0, value: true },
    ]);
    expect((await ccu.listVariables())).toHaveLength(1);
  });

  it('listPrograms delegates to the JSON-RPC client', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listPrograms').mockResolvedValue([{ id: '1', name: 'P' }]);
    expect((await ccu.listPrograms())).toHaveLength(1);
  });

  it('listRooms delegates to the JSON-RPC client', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listRooms').mockResolvedValue([
      { id: '1', name: 'Living', channelIds: ['10', '11'] },
    ]);
    const rooms = await ccu.listRooms();
    expect(rooms[0]?.name).toBe('Living');
    expect(rooms[0]?.channelIds).toEqual(['10', '11']);
  });
});

describe('CcuClient start/stop with no enabled interfaces', () => {
  it('start() succeeds without RPC subscriptions and stop() cleans up', async () => {
    const ccu = makeCcu();
    const start = vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    const stop = vi.spyOn(ccu.eventServer, 'stop').mockResolvedValue(undefined);
    await ccu.start();
    await ccu.start(); // idempotent
    expect(start).toHaveBeenCalledTimes(1);
    await ccu.stop();
    expect(stop).toHaveBeenCalled();
    await ccu.stop(); // idempotent
  });
});

describe('CcuClient resolveCallbackHost', () => {
  it('returns explicit host when not 0.0.0.0', () => {
    const ccu = makeCcu();
    const host = (ccu as unknown as { resolveCallbackHost(): string }).resolveCallbackHost();
    expect(host).toBe('127.0.0.1');
  });

  it('falls back when host is 0.0.0.0', () => {
    const config = resolveConfig({
      platform: 'HomematicHap',
      ccuIp: '127.0.0.1',
      eventServer: { host: '0.0.0.0', port: 9876 },
    });
    const ccu = new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'lc') });
    const host = (ccu as unknown as { resolveCallbackHost(): string }).resolveCallbackHost();
    expect(typeof host).toBe('string');
    expect(host.length).toBeGreaterThan(0);
  });
});

describe('CcuClient setValue/getValue fallback to JSON-RPC', () => {
  it('falls back to api.setInterfaceValue when no XML-RPC client is subscribed', async () => {
    const ccu = makeCcu();
    const spy = vi.spyOn(ccu.api, 'setInterfaceValue').mockResolvedValue(undefined);
    await ccu.setValue('HmIP-RF.000123:1', 'STATE', true);
    expect(spy).toHaveBeenCalledWith('HmIP-RF', '000123:1', 'STATE', 'boolean', true);
  });

  it('falls back to api.getInterfaceValue when no XML-RPC client is subscribed', async () => {
    const ccu = makeCcu();
    const spy = vi.spyOn(ccu.api, 'getInterfaceValue').mockResolvedValue('22.4');
    const v = await ccu.getValue('HmIP-RF.000123:1', 'ACTUAL_TEMPERATURE');
    expect(v).toBe('22.4');
    expect(spy).toHaveBeenCalledWith('HmIP-RF', '000123:1', 'ACTUAL_TEMPERATURE');
  });

  it('routes integer values through JSON-RPC with type=integer', async () => {
    const ccu = makeCcu();
    const spy = vi.spyOn(ccu.api, 'setInterfaceValue').mockResolvedValue(undefined);
    await ccu.setValue('HmIP-RF.000:1', 'KEY', 42);
    expect(spy).toHaveBeenCalledWith('HmIP-RF', '000:1', 'KEY', 'integer', 42);
  });

  it('routes float values through JSON-RPC with type=double', async () => {
    const ccu = makeCcu();
    const spy = vi.spyOn(ccu.api, 'setInterfaceValue').mockResolvedValue(undefined);
    await ccu.setValue('HmIP-RF.000:1', 'LEVEL', 0.75);
    expect(spy).toHaveBeenCalledWith('HmIP-RF', '000:1', 'LEVEL', 'double', 0.75);
  });

  it('routes string values through JSON-RPC with type=string', async () => {
    const ccu = makeCcu();
    const spy = vi.spyOn(ccu.api, 'setInterfaceValue').mockResolvedValue(undefined);
    await ccu.setValue('HmIP-RF.000:1', 'TEXT', 'hello');
    expect(spy).toHaveBeenCalledWith('HmIP-RF', '000:1', 'TEXT', 'string', 'hello');
  });

  it('strips interface prefix correctly when address has no dot', async () => {
    const ccu = makeCcu();
    const spy = vi.spyOn(ccu.api, 'setInterfaceValue').mockResolvedValue(undefined);
    await ccu.setValue('BARE', 'STATE', true);
    expect(spy).toHaveBeenCalled();
  });
});

describe('CcuClient runtime interface discovery', () => {
  it('queries listInterfaces during start() and remembers ports', async () => {
    const ccu = makeCcu();
    const spy = vi.spyOn(ccu.api, 'listInterfaces').mockResolvedValue([
      { name: 'BidCos-RF', port: 32001 },
      { name: 'HmIP-RF', port: 32010 },
      { name: 'VirtualDevices', port: 39292 },
    ]);
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([]);
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    await ccu.start();
    expect(spy).toHaveBeenCalled();
    // discoveredPorts is private — verify via Map size on the instance
    const m = (ccu as unknown as { discoveredPorts: Map<string, number> }).discoveredPorts;
    expect(m.get('BidCos-RF')).toBe(32001);
    expect(m.get('HmIP-RF')).toBe(32010);
    expect(m.get('VirtualDevices')).toBe(39292);
    await ccu.stop();
  });

  it('start() does not crash when listInterfaces throws', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listInterfaces').mockRejectedValue(new Error('ccu-down'));
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([]);
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    await expect(ccu.start()).resolves.toBeUndefined();
    await ccu.stop();
  });

  it('tolerates lower-case / aliased interface names from the CCU', async () => {
    // Regression: v0.1.5 referenced `mapInterfaceName` without defining it,
    // so any non-empty listInterfaces response triggered a ReferenceError
    // that was swallowed by the try/catch and discarded all discovered
    // ports. Verify the mapping accepts the canonical and aliased forms.
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listInterfaces').mockResolvedValue([
      { name: 'BIDCOS-RF', port: 32001 },
      { name: 'hmip-rf', port: 32010 },
      { name: 'CCU-Jack', port: 12345 }, // unknown — should be skipped, not crash
    ]);
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([]);
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    await ccu.start();
    const m = (ccu as unknown as { discoveredPorts: Map<string, number> }).discoveredPorts;
    expect(m.get('BidCos-RF')).toBe(32001);
    expect(m.get('HmIP-RF')).toBe(32010);
    expect(m.size).toBe(2); // CCU-Jack rejected
    await ccu.stop();
  });
});

describe('CcuClient interfacePorts override', () => {
  it('uses the user-supplied port even when listInterfaces returns a different one', async () => {
    // RaspberryMatic firewall regression: listInterfaces returns +30000
    // ports but the CCU firewall blocks them; user pins legacy 2001 in
    // config. The override must beat the discovered value.
    const config = resolveConfig({
      platform: 'HomematicHap',
      ccuIp: '127.0.0.1',
      eventServer: { host: '127.0.0.1', port: 9876 },
      interfaces: { bidcosRf: true, hmIpRf: false, bidcosWired: false, virtualDevices: false, cuxd: false },
      interfacePorts: { 'BidCos-RF': 2001 },
    });
    const ccu = new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'lc-override') });
    vi.spyOn(ccu.api, 'listInterfaces').mockResolvedValue([{ name: 'BidCos-RF', port: 32001 }]);
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([]);
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu.eventServer, 'stop').mockResolvedValue(undefined);

    // Spy on RpcClient ctor by monkey-patching the rpcClients map after start.
    // We can't easily intercept the ctor, so instead we'll observe via the
    // probe failure: subscribe() will fail (no listener on either port), but
    // we can pull the port from the warn log.
    const warns: string[] = [];
    vi.spyOn(ccu['log'] as unknown as { warn: (...args: unknown[]) => void }, 'warn')
      .mockImplementation((fmt: string, ...args: unknown[]) => {
        warns.push([fmt, ...args].map(String).join(' '));
      });
    const infos: string[] = [];
    vi.spyOn(ccu['log'] as unknown as { info: (...args: unknown[]) => void }, 'info')
      .mockImplementation((fmt: string, ...args: unknown[]) => {
        infos.push([fmt, ...args].map(String).join(' '));
      });

    await ccu.start();
    // The startup log should announce port 2001 (override), not 32001 (discovery).
    // PrefixedLogger emits printf-style fmt + args separately; the test
    // captures them as `'fmt arg1 arg2 …'`, so the regex matches that
    // joined form rather than a substituted message.
    expect(infos.join('\n')).toMatch(/Using XML-RPC port .* for .* \(.*\) 2001 BidCos-RF config override/);
    await ccu.stop();
  });
});

describe('CcuClient address → interface lookup', () => {
  it('routes addresses based on the discovered device tree, not the address prefix', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listInterfaces').mockResolvedValue([]);
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([
      {
        address: '0008DBE9971A0F',
        name: 'Blind 1',
        type: 'HmIP-FROLL',
        interface: 'HmIP-RF',
        channels: [
          { address: '0008DBE9971A0F:1', index: 1, type: 'BLIND_VIRTUAL_RECEIVER', name: 'ch1' },
          { address: '0008DBE9971A0F:4', index: 4, type: 'BLIND_VIRTUAL_RECEIVER', name: 'ch4' },
        ],
      },
    ]);
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    await ccu.start();

    const set = vi.spyOn(ccu.api, 'setInterfaceValue').mockResolvedValue(undefined);
    // Even though the address has no `HmIP-RF.` prefix, the lookup map
    // (built from listDevices) sends it to HmIP-RF, not to BidCos-RF.
    await ccu.setValue('0008DBE9971A0F:4', 'LEVEL', 0.5);
    expect(set).toHaveBeenCalledWith('HmIP-RF', '0008DBE9971A0F:4', 'LEVEL', 'double', 0.5);

    await ccu.stop();
  });

  it('falls back to prefix heuristic for addresses missing from the device tree', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listInterfaces').mockResolvedValue([]);
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([]);
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    await ccu.start();

    const set = vi.spyOn(ccu.api, 'setInterfaceValue').mockResolvedValue(undefined);
    await ccu.setValue('HmIP-RF.000:1', 'STATE', true);
    expect(set).toHaveBeenCalledWith('HmIP-RF', '000:1', 'STATE', 'boolean', true);
    await ccu.stop();
  });
});

describe('CcuClient skips CCU-internal loopback interface URLs', () => {
  function remoteCcu(ccuIp: string): CcuClient {
    const config = resolveConfig({
      platform: 'HomematicHap',
      ccuIp,
      eventServer: { host: '127.0.0.1', port: 9876 },
      interfaces: { bidcosRf: false, hmIpRf: false, bidcosWired: false, virtualDevices: false, cuxd: false },
    });
    return new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'lc-loopback') });
  }

  async function discovered(ccu: CcuClient, list: Array<{ name: string; port: number; url?: string }>): Promise<Map<string, number>> {
    vi.spyOn(ccu.api, 'listInterfaces').mockResolvedValue(list);
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([]);
    vi.spyOn(ccu.api, 'logout').mockResolvedValue(undefined);
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu.eventServer, 'stop').mockResolvedValue(undefined);
    await ccu.start();
    const m = new Map((ccu as unknown as { discoveredPorts: Map<string, number> }).discoveredPorts);
    await ccu.stop();
    return m;
  }

  const CCU3_LIST = [
    { name: 'BidCos-RF', port: 32001 },
    { name: 'HmIP-RF', port: 32010 },
    { name: 'VirtualDevices', port: 39292 },
  ];

  it('maps CCU-internal ports (no url in the real answer) to the external ports for a remote CCU', async () => {
    const m = await discovered(remoteCcu('10.0.0.2'), [...CCU3_LIST, { name: 'BidCos-Wired', port: 32000 }]);
    expect([...m.entries()]).toEqual([
      ['BidCos-RF', 2001], ['HmIP-RF', 2010], ['VirtualDevices', 9292], ['BidCos-Wired', 2000],
    ]);
  });

  it('ignores 127.0.0.1 URLs for a remote CCU, mapping to the external ports', async () => {
    const m = await discovered(remoteCcu('10.0.0.2'), CCU3_LIST.map((i) => ({ ...i, url: `xmlrpc://127.0.0.1:${i.port}` })));
    expect(m.get('HmIP-RF')).toBe(2010);
  });

  it('keeps loopback URLs when the CCU itself is the local host', async () => {
    const m = await discovered(remoteCcu('127.0.0.1'), CCU3_LIST);
    expect(m.get('HmIP-RF')).toBe(32010);
  });

  it('keeps non-loopback URLs and entries without a URL', async () => {
    const m = await discovered(remoteCcu('10.0.0.2'), [
      { name: 'BidCos-RF', port: 2001, url: 'xmlrpc://10.0.0.2:2001' },
      { name: 'HmIP-RF', port: 2010 },
      { name: 'VirtualDevices', port: 39292, url: 'xmlrpc://localhost:39292/groups' },
      { name: 'CUxD', port: 8701, url: 'xmlrpc://[::1]:8701' },
    ]);
    expect([...m.entries()]).toEqual([['BidCos-RF', 2001], ['HmIP-RF', 2010], ['VirtualDevices', 9292]]);
  });
});

describe('CcuClient XML-RPC transport security', () => {
  type Endpoint = { port: number; source: string; auth?: unknown; tls?: { allowSelfSigned: boolean; fingerprint256?: string } };
  const FP = Array.from({ length: 32 }, () => '0A').join(':');

  function client(over: Record<string, unknown>): { ccu: CcuClient; warns: string[] } {
    const config = resolveConfig({
      platform: 'HomematicHap',
      ccuIp: '10.0.0.2',
      eventServer: { host: '127.0.0.1', port: 9876 },
      interfaces: { bidcosRf: false, hmIpRf: false, bidcosWired: false, virtualDevices: false, cuxd: false },
      ...over,
    } as never);
    const ccu = new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'lc-tls') });
    const warns: string[] = [];
    vi.spyOn(ccu['log'] as unknown as { warn: (...a: unknown[]) => void }, 'warn')
      .mockImplementation((fmt: string, ...args: unknown[]) => { warns.push([fmt, ...args].map(String).join(' ')); });
    return { ccu, warns };
  }
  const endpoint = (ccu: CcuClient, id: string): Endpoint =>
    (ccu as unknown as { rpcEndpoint(id: string): Endpoint }).rpcEndpoint(id);
  const AUTH = { ccuAuth: { enabled: true, username: 'u', password: 'p' } };

  it('useTls: TLS ports 42001/42010/49292 with credentials and the configured certificate rule', () => {
    const { ccu } = client({ ...AUTH, useTls: true, tlsCertFingerprint: FP.replace(/:/g, '').toLowerCase() });
    expect(endpoint(ccu, 'BidCos-RF')).toMatchObject({ port: 42001, source: 'TLS default', auth: { username: 'u' }, tls: { allowSelfSigned: false, fingerprint256: FP } });
    expect(endpoint(ccu, 'HmIP-RF').port).toBe(42010);
    expect(endpoint(ccu, 'VirtualDevices').port).toBe(49292);
  });

  it('useTls: an interfacePorts override is used as a TLS port, never as plain HTTP', () => {
    const { ccu } = client({ ...AUTH, useTls: true, tlsAllowSelfSigned: true, interfacePorts: { 'HmIP-RF': 2010 } });
    expect(endpoint(ccu, 'HmIP-RF')).toMatchObject({ port: 2010, source: 'config override', tls: { allowSelfSigned: true } });
  });

  it('useTls: CUxD (no TLS port) is reached without credentials, with a warning', () => {
    const { ccu, warns } = client({ ...AUTH, useTls: true });
    const e = endpoint(ccu, 'CUxD');
    expect(e).toMatchObject({ port: 8701 });
    expect(e.auth).toBeUndefined();
    expect(e.tls).toBeUndefined();
    expect(warns.join('\n')).toMatch(/has no TLS XML-RPC port.*without the ccuAuth credentials CUxD/);
  });

  it('without useTls: plain ports with credentials, and exactly one warning across restarts', async () => {
    const { ccu, warns } = client(AUTH);
    expect(endpoint(ccu, 'BidCos-RF')).toMatchObject({ port: 2001, auth: { username: 'u' } });
    expect(endpoint(ccu, 'BidCos-RF').tls).toBeUndefined();
    vi.spyOn(ccu.api, 'listInterfaces').mockResolvedValue([]);
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([]);
    vi.spyOn(ccu.api, 'logout').mockResolvedValue(undefined);
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu.eventServer, 'stop').mockResolvedValue(undefined);
    for (let i = 0; i < 2; i++) {
      await ccu.start();
      await ccu.stop();
    }
    expect(warns.filter((w) => /ccuAuth is set without useTls/.test(w))).toHaveLength(1);
  });

  it('useTls: the JSON API gets the same certificate agent; none without useTls', () => {
    const agentOf = (c: CcuClient): unknown => (c.api as unknown as { tlsAgent?: unknown }).tlsAgent;
    const pinned = client({ ...AUTH, useTls: true, tlsCertFingerprint: FP }).ccu;
    expect((agentOf(pinned) as { constructor: { name: string } }).constructor.name).toBe('PinnedAgent');
    const allow = client({ ...AUTH, useTls: true, tlsAllowSelfSigned: true }).ccu;
    expect((agentOf(allow) as { options: { rejectUnauthorized: boolean } }).options.rejectUnauthorized).toBe(false);
    expect(agentOf(client(AUTH).ccu)).toBeUndefined();
  });

  it('useTls without pin or tlsAllowSelfSigned: ccuAuth is never sent over the JSON API, one clear error at start', async () => {
    const config = resolveConfig({
      platform: 'HomematicHap', ccuIp: '192.0.2.1', useTls: true, ...AUTH,
      eventServer: { host: '127.0.0.1', port: 9876 },
      interfaces: { bidcosRf: false, hmIpRf: false, bidcosWired: false, virtualDevices: false, cuxd: false },
    } as never);
    const ccu = new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'lc-refuse') });
    const errors: string[] = [];
    vi.spyOn(ccu['log'] as unknown as { error: (...a: unknown[]) => void }, 'error')
      .mockImplementation((fmt: string) => { errors.push(fmt); });
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu.eventServer, 'stop').mockResolvedValue(undefined);
    // Real JSON client: the refusing agent fails before any socket is opened.
    const err = await ccu.api.call('Interface.listInterfaces').catch((e: Error & { cause?: Error }) => e);
    expect((err as Error & { cause?: Error }).cause?.message).toBe(TLS_CREDENTIALS_REFUSED);
    for (let i = 0; i < 2; i++) {
      await ccu.start();
      await ccu.stop();
    }
    expect(errors.filter((e) => e === TLS_CREDENTIALS_REFUSED)).toHaveLength(1);
  });

  it('without auth: no credentials and no warning', async () => {
    const { ccu, warns } = client({});
    expect(endpoint(ccu, 'HmIP-RF').auth).toBeUndefined();
    vi.spyOn(ccu.api, 'listInterfaces').mockResolvedValue([]);
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([]);
    vi.spyOn(ccu.api, 'logout').mockResolvedValue(undefined);
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu.eventServer, 'stop').mockResolvedValue(undefined);
    await ccu.start();
    await ccu.stop();
    expect(warns).toEqual([]);
  });
});

describe('CcuClient log hygiene', () => {
  function make(over: Record<string, unknown>): CcuClient {
    const config = resolveConfig({
      platform: 'HomematicHap',
      ccuIp: '10.0.0.2',
      eventServer: { host: '127.0.0.1', port: 9876 },
      interfaces: { bidcosRf: true, hmIpRf: true, bidcosWired: false, virtualDevices: false, cuxd: false },
      ...over,
    } as never);
    return new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'lc-hyg') });
  }
  const spyLevel = (ccu: CcuClient, level: 'info' | 'warn' | 'debug'): string[] => {
    const out: string[] = [];
    vi.spyOn(ccu['log'] as unknown as Record<string, (...a: unknown[]) => void>, level)
      .mockImplementation((fmt: string, ...args: unknown[]) => { out.push([fmt, ...args].map(String).join(' ')); });
    return out;
  };

  it('unrouted events log at debug only and never print IP_ADDRESS values', () => {
    const ccu = make({});
    const info = spyLevel(ccu, 'info');
    const debug = spyLevel(ccu, 'debug');
    const handle = (ccu as unknown as { handleEvent(e: unknown): void }).handleEvent.bind(ccu);
    handle({ channelAddress: 'DEV0001:0', datapoint: 'RSSI_DEVICE', value: -60, receivedAt: 1 });
    handle({ channelAddress: 'DEV0001:0', datapoint: 'IP_ADDRESS', value: 'SECRET-VALUE', receivedAt: 2 });
    expect(info).toHaveLength(0);
    expect(debug.join('\n')).toContain('DEV0001:0.RSSI_DEVICE -60');
    expect(debug.join('\n')).not.toMatch(/IP_ADDRESS|SECRET-VALUE/);
  });

  it('TLS credentials refusal: one subscribe warning per start, not per interface', async () => {
    const ccu = make({});
    const warns = spyLevel(ccu, 'warn');
    vi.spyOn(ccu.api, 'listInterfaces').mockResolvedValue([]);
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([]);
    vi.spyOn(ccu.api, 'logout').mockResolvedValue(undefined);
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu.eventServer, 'stop').mockResolvedValue(undefined);
    vi.spyOn(RpcClient.prototype, 'subscribe').mockRejectedValue(new Error(TLS_CREDENTIALS_REFUSED));
    await ccu.start();
    await ccu.stop();
    expect(warns.filter((w) => w.startsWith('Could not subscribe'))).toHaveLength(1);
    await ccu.start();
    await ccu.stop();
    expect(warns.filter((w) => w.startsWith('Could not subscribe'))).toHaveLength(2);
  });

  it('other subscribe failures are still reported per interface', async () => {
    const ccu = make({});
    const warns = spyLevel(ccu, 'warn');
    vi.spyOn(ccu.api, 'listInterfaces').mockResolvedValue([]);
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([]);
    vi.spyOn(ccu.api, 'logout').mockResolvedValue(undefined);
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu.eventServer, 'stop').mockResolvedValue(undefined);
    vi.spyOn(RpcClient.prototype, 'subscribe').mockRejectedValue(new Error('boom'));
    await ccu.start();
    await ccu.stop();
    expect(warns.filter((w) => w.startsWith('Could not subscribe'))).toHaveLength(2);
  });
});

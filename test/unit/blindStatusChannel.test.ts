import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import { resolveConfig } from '../../src/util/config.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { asPlatformAccessory, makeAccessory, makeHapStub, makeLog } from '../helpers/hapStub.js';
import type { CcuChannel } from '../../src/types.js';
import type { ServiceContext } from '../../src/services/types.js';
import { blindService, transmitterAddress } from '../../src/services/impl/BlindAccessory.js';

const INC = 1;
const DEC = 0;
const STOP = 2;
const DEV = 'HmIPW.0001';

type Values = Record<string, unknown>;

const ch = (dev: string, index: number, type: string): CcuChannel => ({ address: `${dev}:${index}`, name: `c${index}`, index, type });
/** HmIPW-DRBL4: transmitters 1/5/9/13, each followed by three virtual receivers. */
function drbl4(dev = DEV): CcuChannel[] {
  const out: CcuChannel[] = [];
  for (let n = 1; n <= 16; n++) out.push(ch(dev, n, (n - 1) % 4 === 0 ? 'BLIND_TRANSMITTER' : 'BLIND_VIRTUAL_RECEIVER'));
  return out;
}
/** HmIP-BROLL (not supported by the status channel feature): 1-2 key transceivers, 3 transmitter, 4-6 virtual receivers. */
function broll(dev = DEV, transmitter = 'SHUTTER_TRANSMITTER', virtual = 'SHUTTER_VIRTUAL_RECEIVER'): CcuChannel[] {
  return [
    ch(dev, 1, 'KEY_TRANSCEIVER'), ch(dev, 2, 'KEY_TRANSCEIVER'), ch(dev, 3, transmitter),
    ch(dev, 4, virtual), ch(dev, 5, virtual), ch(dev, 6, virtual),
  ];
}

/** `values` maps "<address>.<datapoint>" to what getValue answers; a missing key rejects. */
async function setup(
  type: string,
  n: number,
  values: Values,
  settings?: Record<string, unknown>,
  siblings: CcuChannel[] | null = drbl4(),
) {
  const address = `${DEV}:${n}`;
  const config = resolveConfig({ platform: 'HomematicHap', ccuIp: '127.0.0.1' });
  const ccu = new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'blind') });
  const setValue = vi.spyOn(ccu, 'setValue').mockResolvedValue(undefined);
  const getValue = vi.spyOn(ccu, 'getValue').mockImplementation(async (a, dp) => {
    const key = `${a}.${dp}`;
    if (!(key in values)) throw new Error(`no value ${key}`);
    return values[key];
  });
  const fire = (channel: number, datapoint: string, value: unknown) => {
    (ccu as unknown as { handleEvent(ev: object): void }).handleEvent({
      callbackId: 'c', channelAddress: `${DEV}:${channel}`, datapoint, value, receivedAt: 0,
    });
  };
  const rawLog = makeLog();
  const hap = makeHapStub();
  const mk = (name: string) => {
    class C { static UUID = `char:${name}`; UUID = `char:${name}`; }
    Object.defineProperty(C, 'name', { value: name });
    return C;
  };
  const S = class { static UUID = 'srv:WindowCovering'; UUID = 'srv:WindowCovering'; displayName = ''; subtype: string | undefined; };
  const Characteristic = { ...hap.Characteristic } as Record<string, unknown>;
  for (const c of ['CurrentPosition', 'TargetPosition', 'PositionState', 'Name', 'CurrentHorizontalTiltAngle', 'TargetHorizontalTiltAngle']) {
    Characteristic[c] = mk(c);
  }
  const accessory = makeAccessory('uuid', 'Blind', { kind: 'channel', id: address, service: 'BlindAccessory', settings });
  const ctx = {
    accessory: asPlatformAccessory(accessory),
    ccu,
    log: new PrefixedLogger(rawLog, 'blind'),
    Service: { ...hap.Service, WindowCovering: S },
    Characteristic,
  } as unknown as ServiceContext;
  const channel: CcuChannel = { address, name: 'Blind', index: n, type, ...(siblings ? { siblings } : {}) };
  const handler = blindService.build(ctx);
  handler.attach(channel);
  await vi.advanceTimersByTimeAsync(0);
  const get = (c: string) => accessory.services[0]!.characteristics.get(`char:${c}`)!;
  return {
    fire, setValue, getValue, handler, get, rawLog, ccu,
    pos: () => get('CurrentPosition').value,
    tgt: () => get('TargetPosition').onGetHandler!() as Promise<unknown>,
    state: () => get('PositionState').value,
    command: (v: number) => get('TargetPosition').onSetHandler!(v),
  };
}

const status = (level = 0.5): Values => ({ [`${DEV}:1.LEVEL`]: level, [`${DEV}:2.LEVEL`]: 0.1 });

describe('transmitterAddress', () => {
  it('DRBL4: maps virtual receivers to the transmitter of their group', () => {
    const map = (n: number) => transmitterAddress(`${DEV}:${n}`, drbl4());
    expect([2, 3, 4].map(map)).toEqual([`${DEV}:1`, `${DEV}:1`, `${DEV}:1`]);
    expect([6, 7, 8].map(map)).toEqual([`${DEV}:5`, `${DEV}:5`, `${DEV}:5`]);
    expect([10, 11, 12].map(map)).toEqual([`${DEV}:9`, `${DEV}:9`, `${DEV}:9`]);
    expect([14, 15, 16].map(map)).toEqual([`${DEV}:13`, `${DEV}:13`, `${DEV}:13`]);
  });

  it('BROLL, FROLL, BBL, FBL layouts (transmitter is channel 3): no transmitter, virtual channel as before', () => {
    for (const layout of [broll(), broll(DEV, 'BLIND_TRANSMITTER', 'BLIND_VIRTUAL_RECEIVER')]) {
      for (const n of [4, 5, 6]) {
        expect(transmitterAddress(`${DEV}:${n}`, layout)).toBeUndefined();
      }
    }
  });

  it('has no transmitter for the transmitter itself, a key channel, channel 0 or an address without index', () => {
    expect(transmitterAddress(`${DEV}:1`, drbl4())).toBeUndefined();
    expect(transmitterAddress(`${DEV}:5`, drbl4())).toBeUndefined();
    expect(transmitterAddress(`${DEV}:2`, broll())).toBeUndefined();
    expect(transmitterAddress(`${DEV}:0`, drbl4())).toBeUndefined();
    expect(transmitterAddress(DEV, drbl4())).toBeUndefined();
  });

  it('ignores channels of other devices and later channels', () => {
    const others = [...drbl4('OTHER'), ch(DEV, 9, 'BLIND_TRANSMITTER'), ch(DEV, 2, 'BLIND_VIRTUAL_RECEIVER')];
    expect(transmitterAddress(`${DEV}:2`, others)).toBeUndefined();
  });

  it('unknown channel types: no transmitter (virtual-only), no arithmetic guess', () => {
    expect(transmitterAddress(`${DEV}:2`, undefined)).toBeUndefined();
    expect(transmitterAddress(`${DEV}:2`, [])).toBeUndefined();
    expect(transmitterAddress(`${DEV}:6`, [ch(DEV, 5, ''), ch(DEV, 6, '')])).toBeUndefined();
  });
});

describe('BlindAccessory status channel (HmIP virtual receivers)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads the initial position from the transmitter, not the stale virtual channel', async () => {
    const t = await setup('BLIND_VIRTUAL_RECEIVER', 2, status(0.7));
    expect(t.getValue).toHaveBeenCalledWith(`${DEV}:1`, 'LEVEL');
    expect(t.pos()).toBe(70);
    expect(await t.tgt()).toBe(70);
    expect(t.state()).toBe(STOP);
  });

  it('wall button move: only transmitter events, position and state follow, target follows once stopped', async () => {
    const t = await setup('SHUTTER_VIRTUAL_RECEIVER', 6, { [`${DEV}:5.LEVEL`]: 1 });
    const fire = (dp: string, v: unknown) => t.fire(5, dp, v);
    fire('ACTIVITY_STATE', 2);
    fire('PROCESS', 1);
    expect(t.state()).toBe(DEC);
    fire('LEVEL', 0.6);
    expect(t.pos()).toBe(60);
    expect(t.state()).toBe(DEC);
    expect(await t.tgt()).toBe(60);
    fire('LEVEL', 0.2);
    fire('ACTIVITY_STATE', 3);
    fire('PROCESS', 0);
    expect(t.pos()).toBe(20);
    expect(t.state()).toBe(STOP);
    expect(await t.tgt()).toBe(20);
    expect(t.setValue).not.toHaveBeenCalled();
  });

  it('ignores a stale LEVEL on the virtual channel once the transmitter drives', async () => {
    const t = await setup('BLIND_VIRTUAL_RECEIVER', 2, status(0.5));
    t.fire(2, 'LEVEL', 0.9);
    t.fire(2, 'ACTIVITY_STATE', 1);
    expect(t.pos()).toBe(50);
    expect(t.state()).toBe(STOP);
  });

  it('PROCESS alone drives moving and stable; a late LEVEL after stable is the final value', async () => {
    const t = await setup('BLIND_VIRTUAL_RECEIVER', 2, status(1));
    t.fire(1, 'PROCESS', 1);
    t.fire(1, 'LEVEL', 0.8);
    expect(t.state()).toBe(DEC);
    t.fire(1, 'PROCESS', 0);
    t.fire(1, 'LEVEL', 0.75);
    expect(t.pos()).toBe(75);
    expect(t.state()).toBe(STOP);
    expect(await t.tgt()).toBe(75);
  });

  it('HomeKit move: the write goes to the virtual channel, progress comes from the transmitter', async () => {
    const t = await setup('BLIND_VIRTUAL_RECEIVER', 2, status(0));
    await t.command(100);
    expect(t.setValue).toHaveBeenCalledTimes(1);
    expect(t.setValue).toHaveBeenCalledWith(`${DEV}:2`, 'LEVEL', 1);
    expect(t.state()).toBe(INC);
    t.fire(1, 'ACTIVITY_STATE', 1);
    t.fire(1, 'LEVEL', 0.5);
    expect(t.pos()).toBe(50);
    expect(await t.tgt()).toBe(100);
    t.fire(1, 'LEVEL', 1);
    t.fire(1, 'ACTIVITY_STATE', 3);
    expect(t.state()).toBe(STOP);
    expect(await t.tgt()).toBe(100);
    expect(t.setValue).toHaveBeenCalledTimes(1);
  });

  it('stop mid-way after a HomeKit move: target settles on the stop position', async () => {
    const t = await setup('BLIND_VIRTUAL_RECEIVER', 10, { [`${DEV}:9.LEVEL`]: 0 });
    await t.command(100);
    t.fire(9, 'ACTIVITY_STATE', 1);
    t.fire(9, 'LEVEL', 0.4);
    expect(await t.tgt()).toBe(100);
    t.fire(9, 'ACTIVITY_STATE', 3);
    t.fire(9, 'PROCESS', 0);
    expect(t.pos()).toBe(40);
    expect(await t.tgt()).toBe(40);
    expect(t.state()).toBe(STOP);
  });

  it('an inhibited blind does not move: the command is written, nothing changes, target settles back', async () => {
    const t = await setup('BLIND_VIRTUAL_RECEIVER', 2, status(0.3), { observeInhibit: true });
    await t.command(100);
    expect(t.setValue).toHaveBeenCalledWith(`${DEV}:2`, 'LEVEL', 1);
    vi.advanceTimersByTime(5001);
    expect(t.pos()).toBe(30);
    expect(t.state()).toBe(STOP);
    expect(await t.tgt()).toBe(30);
    expect(t.setValue).toHaveBeenCalledTimes(1);
  });

  it('falls back to the virtual channel when the transmitter is unreadable, with one warning', async () => {
    const t = await setup('BLIND_VIRTUAL_RECEIVER', 2, { [`${DEV}:2.LEVEL`]: 0.4 });
    expect(t.pos()).toBe(40);
    t.fire(1, 'LEVEL', 0.9); // transmitter events are not used
    expect(t.pos()).toBe(40);
    t.fire(2, 'ACTIVITY_STATE', 2);
    t.fire(2, 'LEVEL', 0.2);
    expect(t.pos()).toBe(20);
    expect(t.state()).toBe(DEC);
    t.fire(2, 'ACTIVITY_STATE', 3);
    expect(t.state()).toBe(STOP);
    const warns = (t.rawLog.warn as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).includes('Status channel'));
    expect(warns).toHaveLength(1);
    expect(t.setValue).not.toHaveBeenCalled();
  });

  it('useStatusChannel false keeps today\'s behaviour and never reads the transmitter', async () => {
    const t = await setup('BLIND_VIRTUAL_RECEIVER', 2, { ...status(0.9), [`${DEV}:2.LEVEL`]: 0.4 }, { useStatusChannel: false });
    expect(t.getValue).not.toHaveBeenCalledWith(`${DEV}:1`, 'LEVEL');
    expect(t.pos()).toBe(40);
    t.fire(1, 'LEVEL', 0.9);
    expect(t.pos()).toBe(40);
    t.fire(2, 'LEVEL', 0.6);
    expect(t.pos()).toBe(60);
  });

  it('classic BLIND and the first channel of a group are untouched', async () => {
    const t = await setup('BLIND', 3, { [`${DEV}:3.LEVEL`]: 0.5 });
    expect(t.getValue).not.toHaveBeenCalledWith(`${DEV}:1`, 'LEVEL');
    const u = await setup('BLIND_VIRTUAL_RECEIVER', 1, { [`${DEV}:1.LEVEL`]: 0.5 });
    expect(u.pos()).toBe(50);
  });

  it('BROLL layout: channel 6 keeps the virtual channel, the transmitter is never read, no warning', async () => {
    const values = { [`${DEV}:3.LEVEL`]: 0.6, [`${DEV}:6.LEVEL`]: 0.2 };
    const t = await setup('SHUTTER_VIRTUAL_RECEIVER', 6, values, undefined, broll());
    expect(t.getValue).not.toHaveBeenCalledWith(`${DEV}:3`, 'LEVEL');
    expect(t.pos()).toBe(20);
    t.fire(3, 'LEVEL', 0.4);
    expect(t.pos()).toBe(20);
    t.fire(6, 'LEVEL', 0.9);
    expect(t.pos()).toBe(90);
    const warns = (t.rawLog.warn as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).includes('Status channel'));
    expect(warns).toHaveLength(0);
  });

  it('without channel types the virtual channel is used and the transmitter is never read', async () => {
    const t = await setup('BLIND_VIRTUAL_RECEIVER', 2, { ...status(0.9), [`${DEV}:2.LEVEL`]: 0.4 }, undefined, null);
    expect(t.getValue).not.toHaveBeenCalledWith(`${DEV}:1`, 'LEVEL');
    expect(t.pos()).toBe(40);
    t.fire(1, 'LEVEL', 0.9);
    expect(t.pos()).toBe(40);
  });

  it('a stale stable report from the transmitter before the motor starts does not undo the target', async () => {
    const t = await setup('BLIND_VIRTUAL_RECEIVER', 2, status(0));
    await t.command(100);
    t.fire(1, 'PROCESS', 0);
    t.fire(1, 'ACTIVITY_STATE', 3);
    expect(await t.tgt()).toBe(100);
    expect(t.state()).toBe(INC);
    t.fire(1, 'ACTIVITY_STATE', 1);
    t.fire(1, 'LEVEL', 0.5);
    expect(await t.tgt()).toBe(100);
    t.fire(1, 'LEVEL', 1);
    t.fire(1, 'ACTIVITY_STATE', 3);
    expect(t.state()).toBe(STOP);
    expect(await t.tgt()).toBe(100);
  });

  it('the stale-stable guard ends after about 5 s, and a moving report ends it earlier', async () => {
    const t = await setup('BLIND_VIRTUAL_RECEIVER', 2, status(0));
    await t.command(100);
    await vi.advanceTimersByTimeAsync(5001);
    expect(t.state()).toBe(STOP);
    expect(await t.tgt()).toBe(0);
    await t.command(100);
    t.fire(1, 'PROCESS', 1);
    t.fire(1, 'PROCESS', 0);
    expect(t.state()).toBe(STOP);
    expect(await t.tgt()).toBe(0);
  });

  it('a stable report whose LEVEL already equals the target is not stale', async () => {
    const t = await setup('BLIND_VIRTUAL_RECEIVER', 2, status(0));
    await t.command(100);
    t.fire(1, 'LEVEL', 1);
    t.fire(1, 'PROCESS', 0);
    expect(t.state()).toBe(STOP);
    expect(await t.tgt()).toBe(100);
  });

  describe('slats (useSlats)', () => {
    it('LEVEL_2 from the transmitter updates the tilt; tilt writes still target the virtual channel', async () => {
      const values = { ...status(0.5), [`${DEV}:1.LEVEL_2`]: 1 };
      const t = await setup('BLIND_VIRTUAL_RECEIVER', 2, values, { useSlats: true });
      expect(t.get('CurrentHorizontalTiltAngle').value).toBe(90);
      t.fire(1, 'LEVEL_2', 0.5);
      expect(t.get('CurrentHorizontalTiltAngle').value).toBe(0);
      expect(t.get('TargetHorizontalTiltAngle').value).toBe(0);
      await t.get('TargetHorizontalTiltAngle').onSetHandler!(-90);
      await vi.advanceTimersByTimeAsync(2000);
      for (const call of t.setValue.mock.calls) {
        expect(String(call[0])).toBe(`${DEV}:2`);
      }
    });

    it('tilt has one source: virtual LEVEL_2 events are ignored while the transmitter drives', async () => {
      const values = { ...status(0.5), [`${DEV}:1.LEVEL_2`]: 1 };
      const t = await setup('BLIND_VIRTUAL_RECEIVER', 2, values, { useSlats: true });
      t.fire(2, 'LEVEL_2', 0);
      expect(t.get('CurrentHorizontalTiltAngle').value).toBe(90);
    });

    it('falls back to the virtual LEVEL_2 when the transmitter has none', async () => {
      const values = { [`${DEV}:2.LEVEL`]: 0.5, [`${DEV}:2.LEVEL_2`]: 0 };
      const t = await setup('BLIND_VIRTUAL_RECEIVER', 2, values, { useSlats: true });
      expect(t.get('CurrentHorizontalTiltAngle').value).toBe(-90);
    });
  });
});

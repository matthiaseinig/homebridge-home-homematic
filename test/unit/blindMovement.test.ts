import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import { resolveConfig } from '../../src/util/config.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { asPlatformAccessory, makeAccessory, makeHapStub, makeLog } from '../helpers/hapStub.js';
import type { CcuChannel } from '../../src/types.js';
import type { ServiceContext } from '../../src/services/types.js';
import { blindService } from '../../src/services/impl/BlindAccessory.js';

const INC = 1;
const DEC = 0;
const STOP = 2;

function setup(type: string, address: string, settings?: Record<string, unknown>, slatWriteMode?: string) {
  const config = resolveConfig({ platform: 'HomematicHap', ccuIp: '127.0.0.1', ...(slatWriteMode ? { slatWriteMode } : {}) });
  const ccu = new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'blind') });
  const setValue = vi.spyOn(ccu, 'setValue').mockResolvedValue(undefined);
  const getValue = vi.spyOn(ccu, 'getValue').mockResolvedValue(undefined);
  const fire = (datapoint: string, value: unknown) => {
    (ccu as unknown as { handleEvent(ev: object): void }).handleEvent({
      callbackId: 'c', channelAddress: address, datapoint, value, receivedAt: 0,
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
  for (const n of ['CurrentPosition', 'TargetPosition', 'PositionState', 'Name', 'CurrentHorizontalTiltAngle', 'TargetHorizontalTiltAngle']) {
    Characteristic[n] = mk(n);
  }
  const accessory = makeAccessory('uuid', 'Blind', { kind: 'channel', id: address, service: 'BlindAccessory', settings });
  const ctx = {
    accessory: asPlatformAccessory(accessory),
    ccu,
    log: new PrefixedLogger(rawLog, 'blind'),
    Service: { ...hap.Service, WindowCovering: S },
    Characteristic,
  } as unknown as ServiceContext;
  const channel: CcuChannel = { address, name: 'Blind', index: 1, type };
  const handler = blindService.build(ctx);
  handler.attach(channel);
  const svc = accessory.services[0]!;
  const get = (n: string) => svc.characteristics.get(`char:${n}`)!;
  return {
    fire, setValue, getValue, handler, get, svc, accessory, rawLog,
    reattach: () => blindService.build(ctx).attach(channel),
    pos: () => get('CurrentPosition').value,
    tgt: () => get('TargetPosition').onGetHandler!() as Promise<unknown>,
    state: () => get('PositionState').value,
    command: (v: number) => get('TargetPosition').onSetHandler!(v),
  };
}

describe('BlindAccessory movement', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('classic BLIND up with WORKING: target stays, every LEVEL is pushed, stops on WORKING=false', async () => {
    const t = setup('BLIND', 'NEQ1:1');
    t.fire('LEVEL', 0);
    await t.command(100);
    expect(t.setValue).toHaveBeenCalledWith('NEQ1:1', 'LEVEL', 1);
    expect(await t.tgt()).toBe(100);
    expect(t.state()).toBe(INC);
    t.fire('WORKING', true);
    for (const l of [0.2, 0.5, 0.8]) {
      t.fire('LEVEL', l);
      expect(t.pos()).toBe(Math.round(l * 100));
      expect(await t.tgt()).toBe(100);
      expect(t.state()).toBe(INC);
    }
    t.fire('LEVEL', 1);
    expect(t.pos()).toBe(100);
    expect(t.state()).toBe(STOP);
    t.fire('WORKING', false);
    expect(t.state()).toBe(STOP);
    expect(await t.tgt()).toBe(100);
  });

  it('classic BLIND down from a wall button: WORKING + DIRECTION, target follows current', async () => {
    const t = setup('BLIND', 'NEQ1:1');
    t.fire('LEVEL', 1);
    t.fire('WORKING', true);
    t.fire('DIRECTION', 2);
    expect(t.state()).toBe(DEC);
    t.fire('LEVEL', 0.6);
    expect(t.state()).toBe(DEC);
    expect(await t.tgt()).toBe(60);
    t.fire('DIRECTION', 0); // ignored
    t.fire('WORKING', false);
    expect(t.state()).toBe(STOP);
    expect(t.pos()).toBe(60);
  });

  it('HmIP ACTIVITY_STATE drives the state and 3 = stable ends it, late LEVEL does not re-arm moving', () => {
    const t = setup('BLIND_VIRTUAL_RECEIVER', 'HmIP.A:4');
    t.fire('LEVEL', 0.8);
    t.fire('ACTIVITY_STATE', 2);
    expect(t.state()).toBe(DEC);
    t.fire('LEVEL', 0.5);
    expect(t.state()).toBe(DEC);
    t.fire('ACTIVITY_STATE', 3);
    expect(t.state()).toBe(STOP);
    t.fire('LEVEL', 0.3); // final value arriving after "stable"
    expect(t.pos()).toBe(30);
    expect(t.state()).toBe(STOP);
    t.fire('ACTIVITY_STATE', 1);
    expect(t.state()).toBe(INC);
    t.fire('ACTIVITY_STATE', 0); // unknown ignored
    expect(t.state()).toBe(INC);
    t.fire('ACTIVITY_STATE', 3);
    expect(t.state()).toBe(STOP);
  });

  it('HmIP stop midway after a HomeKit command: target settles on the stop position', async () => {
    const t = setup('SHUTTER_VIRTUAL_RECEIVER', 'HmIP.A:5');
    t.fire('LEVEL', 0);
    await t.command(100);
    t.fire('ACTIVITY_STATE', 1);
    t.fire('LEVEL', 0.4);
    expect(await t.tgt()).toBe(100);
    expect(t.state()).toBe(INC);
    t.fire('ACTIVITY_STATE', 3);
    expect(t.state()).toBe(STOP);
    expect(t.pos()).toBe(40);
    expect(await t.tgt()).toBe(40);
  });

  it('stops after the level stops changing (no explicit stop signal)', async () => {
    const t = setup('BLIND_VIRTUAL_RECEIVER', 'HmIP.A:4');
    t.fire('LEVEL', 0.9);
    await t.command(10);
    expect(t.state()).toBe(DEC);
    t.fire('LEVEL', 0.7);
    vi.advanceTimersByTime(4000);
    expect(t.state()).toBe(DEC);
    t.fire('LEVEL', 0.6); // re-arms
    vi.advanceTimersByTime(4000);
    expect(t.state()).toBe(DEC);
    vi.advanceTimersByTime(1500);
    expect(t.state()).toBe(STOP);
    expect(await t.tgt()).toBe(60);
  });

  it('a command to the current position is a no-op move; a command with no CCU response times out', async () => {
    const t = setup('BLIND', 'NEQ1:1');
    t.fire('LEVEL', 0.5);
    await t.command(50);
    expect(t.state()).toBe(STOP);
    await t.command(80);
    expect(t.state()).toBe(INC);
    vi.advanceTimersByTime(5001);
    expect(t.state()).toBe(STOP);
    expect(await t.tgt()).toBe(50);
  });

  it('WORKING=true after a command keeps the commanded direction; failsafe ends a lost stop', async () => {
    const t = setup('BLIND', 'NEQ1:1');
    t.fire('LEVEL', 1);
    await t.command(0);
    t.fire('WORKING', true);
    expect(t.state()).toBe(DEC);
    vi.advanceTimersByTime(60000);
    expect(t.state()).toBe(DEC);
    vi.advanceTimersByTime(61000);
    expect(t.state()).toBe(STOP);
  });

  it('WORKING=true with unknown direction stays STOPPED until a LEVEL shows it; dispose clears the timer', () => {
    const t = setup('BLIND', 'NEQ1:1');
    t.fire('WORKING', true);
    expect(t.state()).toBe(STOP);
    t.fire('LEVEL', 0.3);
    expect(t.state()).toBe(INC);
    t.handler.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('BlindAccessory slat tilt (useSlats)', () => {
  const TILT_CHARS = ['CurrentHorizontalTiltAngle', 'TargetHorizontalTiltAngle'];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('without useSlats there is no tilt', () => {
    for (const settings of [undefined, { useSlats: false }]) {
      const t = setup('BLIND_VIRTUAL_RECEIVER', 'HmIP.B:4', settings);
      for (const n of TILT_CHARS) expect(t.get(n)).toBeUndefined();
    }
  });

  it('with useSlats LEVEL_2 events update the tilt angle', () => {
    const t = setup('BLIND_VIRTUAL_RECEIVER', 'HmIP.B:4', { useSlats: true });
    t.fire('LEVEL_2', 1);
    expect(t.get('CurrentHorizontalTiltAngle').value).toBe(90);
    expect(t.get('TargetHorizontalTiltAngle').value).toBe(90);
  });

  it('with useSlats movement reporting is intact and the position goes out at once as plain LEVEL', async () => {
    const t = setup('BLIND_VIRTUAL_RECEIVER', 'HmIP.B:4', { useSlats: true });
    t.fire('LEVEL', 0);
    t.fire('LEVEL_2', 0.5);
    await t.command(100);
    expect(t.setValue.mock.calls).toEqual([['HmIP.B:4', 'LEVEL', 1]]);
    expect(t.state()).toBe(INC);
    t.fire('ACTIVITY_STATE', 1);
    t.fire('LEVEL', 0.5);
    expect(t.pos()).toBe(50);
    expect(await t.tgt()).toBe(100);
    t.fire('LEVEL_2', 0.5);
    expect(await t.tgt()).toBe(100);
    expect(t.state()).toBe(INC);
    t.fire('ACTIVITY_STATE', 3);
    expect(t.state()).toBe(STOP);
  });

  it('reports LEVEL_2 above 1 clamped, for display only', () => {
    const t = setup('BLIND_VIRTUAL_RECEIVER', 'HmIP.B:4', { useSlats: true });
    t.fire('LEVEL_2', 1.01);
    expect(t.get('CurrentHorizontalTiltAngle').value).toBe(90);
    expect(t.setValue).not.toHaveBeenCalled();
  });
});

describe('slat writes (slatWriteMode)', () => {
  const ADDR = 'HmIP.B:4';
  const tilt = (t: ReturnType<typeof setup>, v: number) => t.get('TargetHorizontalTiltAngle').onSetHandler!(v);
  const dps = (t: ReturnType<typeof setup>) => t.setValue.mock.calls.map(([, dp, v]) => [dp, v]);
  const warns = (t: ReturnType<typeof setup>) => (t.rawLog as unknown as { warn: { mock: { calls: unknown[] } } }).warn.mock.calls.length;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('positions go out at once as plain LEVEL in every mode, with no COMBINED_PARAMETER', async () => {
    for (const mode of [undefined, 'level2-then-stop', 'level2']) {
      const t = setup('BLIND_VIRTUAL_RECEIVER', ADDR, { useSlats: true }, mode);
      await t.command(70);
      expect(dps(t)).toEqual([['LEVEL', 0.7]]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(dps(t)).toEqual([['LEVEL', 0.7]]);
    }
  });

  it('combined (default): tilt is debounced, last value wins, one lone L2 write', async () => {
    const t = setup('BLIND_VIRTUAL_RECEIVER', ADDR, { useSlats: true });
    t.fire('LEVEL', 0.4);
    await tilt(t, -90);
    await tilt(t, 0);
    await vi.advanceTimersByTimeAsync(900);
    expect(t.setValue).not.toHaveBeenCalled();
    await tilt(t, 90);
    await vi.advanceTimersByTimeAsync(999);
    expect(t.setValue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(dps(t)).toEqual([['COMBINED_PARAMETER', 'L2=100']]);
  });

  it('a tilt during a move never sends L, and the move keeps its target', async () => {
    const t = setup('BLIND_VIRTUAL_RECEIVER', ADDR, { useSlats: true });
    t.fire('LEVEL', 0);
    await t.command(100);
    t.fire('ACTIVITY_STATE', 1);
    t.fire('LEVEL', 0.3);
    await tilt(t, 0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(dps(t)).toEqual([['LEVEL', 1], ['COMBINED_PARAMETER', 'L2=50']]);
    expect(dps(t).some(([, v]) => String(v).includes('L='))).toBe(false);
    expect(await t.tgt()).toBe(100);
  });

  it('a failed tilt write resets the target tilt, logs once and is never replayed', async () => {
    const t = setup('BLIND_VIRTUAL_RECEIVER', ADDR, { useSlats: true });
    t.fire('LEVEL_2', 0.5);
    t.setValue.mockRejectedValue(new Error('boom'));
    await tilt(t, 90);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.get('TargetHorizontalTiltAngle').value).toBe(0);
    expect(warns(t)).toBe(1);
    await tilt(t, 90);
    await vi.advanceTimersByTimeAsync(1000);
    expect(warns(t)).toBe(1);
    t.setValue.mockReset().mockResolvedValue(undefined);
    await t.command(40);
    await vi.advanceTimersByTimeAsync(10000);
    expect(dps(t)).toEqual([['LEVEL', 0.4]]);
  });

  it('level2-then-stop: LEVEL_2 then STOP when still, STOP skipped while moving', async () => {
    const t = setup('BLIND_VIRTUAL_RECEIVER', ADDR, { useSlats: true }, 'level2-then-stop');
    await tilt(t, 0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(dps(t)).toEqual([['LEVEL_2', 0.5], ['STOP', true]]);
    t.setValue.mockClear();
    t.fire('LEVEL', 0);
    await t.command(100);
    t.setValue.mockClear();
    await tilt(t, 90);
    await vi.advanceTimersByTimeAsync(1000);
    expect(dps(t)).toEqual([['LEVEL_2', 1]]);
  });

  it('level2 (legacy): LEVEL_2 is written at once', async () => {
    const t = setup('BLIND_VIRTUAL_RECEIVER', ADDR, { useSlats: true }, 'level2');
    await tilt(t, 90);
    expect(dps(t)).toEqual([['LEVEL_2', 1]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.setValue).toHaveBeenCalledTimes(1);
  });

  it('removes tilt characteristics from a cached accessory when useSlats is off', () => {
    const t = setup('BLIND_VIRTUAL_RECEIVER', ADDR, { useSlats: true });
    expect(t.svc.characteristics.has('char:TargetHorizontalTiltAngle')).toBe(true);
    expect(t.svc.characteristics.has('char:CurrentHorizontalTiltAngle')).toBe(true);
    (t.accessory.context as { settings: Record<string, unknown> }).settings = { useSlats: false };
    t.reattach();
    expect(t.svc.characteristics.has('char:TargetHorizontalTiltAngle')).toBe(false);
    expect(t.svc.characteristics.has('char:CurrentHorizontalTiltAngle')).toBe(false);
    expect(t.svc.characteristics.has('char:TargetPosition')).toBe(true);
  });
});

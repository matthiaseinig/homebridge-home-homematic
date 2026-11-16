import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser ES module without types
import { SECRET_KEYS, buildSnapshot, configRevision, keptFields, processApply } from '../../homebridge-ui/public/large-view-host.js';

const SERVICES = [
  { key: 'SwitchAccessory', description: 'Switch', channelTypes: ['SWITCH_VIRTUAL_RECEIVER'], variants: [] },
  { key: 'BlindAccessory', description: 'Blind', channelTypes: ['BLIND_VIRTUAL_RECEIVER'], variants: [{ id: 'blind', label: 'Blind' }, { id: 'slats', label: 'Slats' }] },
];

function blocks() {
  return [
    {
      platform: 'HomematicHap', name: 'Main', ccuIp: '10.0.0.2',
      ccuAuth: { enabled: true, username: 'admin', password: 'very-secret-pw' },
      multiBridge: undefined,
      channels: [
        { address: 'AAA:1', name: 'Licht', service: 'SwitchAccessory', instance: 'i1', uuidSeed: 'seed-1', settings: { x: 1 } },
        { address: 'BBB:3', name: 'Rollo', service: 'BlindAccessory', subtype: 'blind' },
      ],
      variables: [{ name: 'v' }],
      programs: [],
    },
    {
      platform: 'HomematicHap', name: 'Keller', _bridge: { username: '0E:00:00:00:00:01', port: 30001 },
      ccuAuth: { enabled: true, username: 'admin', password: 'very-secret-pw' },
      channels: [],
      variables: [], programs: [],
    },
  ];
}

const state = (b = blocks()) => ({
  blocks: b,
  services: { channelServices: SERVICES },
  discovered: { devices: [{ address: 'AAA', name: 'Dev', type: 'HmIP-PS', channels: [{ address: 'AAA:1', name: 'ch', type: 'SWITCH_VIRTUAL_RECEIVER' }] }] },
  pluginVersion: '1.9.0',
});

describe('large view host: snapshot', () => {
  it('never contains the CCU credentials', () => {
    const snap = buildSnapshot(state());
    const json = JSON.stringify(snap);
    expect(SECRET_KEYS).toContain('ccuAuth');
    expect(json).not.toContain('ccuAuth');
    expect(json).not.toContain('very-secret-pw');
    expect(json).not.toContain('admin');
    expect(snap.blocks).toEqual([
      { name: 'Main', channels: blocks()[0]!.channels },
      { name: 'Keller', channels: [] },
    ]);
    expect(snap.services).toEqual(SERVICES);
    expect(snap.devices).toHaveLength(1);
    expect(snap.revision).toBe(configRevision(blocks()));
  });

  it('revision ignores the credentials but follows every other change', () => {
    const a = blocks();
    const b = blocks();
    b[0]!.ccuAuth.password = 'changed';
    expect(configRevision(a)).toBe(configRevision(b));
    b[0]!.ccuIp = '10.0.0.3';
    expect(configRevision(a)).not.toBe(configRevision(b));
  });
});

describe('large view host: apply', () => {
  const rev = () => configRevision(blocks());

  it('rejects a stale revision and changes nothing', () => {
    const s = state();
    const before = JSON.stringify(s.blocks);
    const r = processApply(s, { revision: 'deadbeef', ops: [{ op: 'remove', address: 'AAA:1' }] });
    expect(r).toMatchObject({ ok: false, code: 'stale' });
    expect(JSON.stringify(s.blocks)).toBe(before);
  });

  it('applies a rename in place and keeps the credentials and identity fields', () => {
    const s = state();
    const r = processApply(s, { revision: rev(), ops: [{ op: 'set', address: 'AAA:1', name: 'Küche Licht', service: 'SwitchAccessory', bridgeIndex: 0 }] });
    expect(r.ok).toBe(true);
    expect(r.blocks[0].ccuAuth).toEqual({ enabled: true, username: 'admin', password: 'very-secret-pw' });
    expect(r.blocks[1].ccuAuth).toEqual({ enabled: true, username: 'admin', password: 'very-secret-pw' });
    expect(r.blocks[0].channels[0]).toEqual({
      address: 'AAA:1', name: 'Küche Licht', service: 'SwitchAccessory', instance: 'i1', uuidSeed: 'seed-1', settings: { x: 1 },
    });
    expect(r.blocks[0].variables).toEqual([{ name: 'v' }]);
    // input untouched
    expect(s.blocks[0]!.channels[0]!.name).toBe('Licht');
  });

  it('ignores credentials or extra fields smuggled into an op', () => {
    const s = state();
    const r = processApply(s, { revision: rev(), ops: [{
      op: 'set', address: 'AAA:1', name: 'X', service: 'SwitchAccessory', bridgeIndex: 0,
      ccuAuth: { enabled: false }, uuidSeed: 'evil', ccuIp: '1.2.3.4',
    }] });
    expect(r.ok).toBe(true);
    expect(r.blocks[0].ccuAuth.password).toBe('very-secret-pw');
    expect(r.blocks[0].ccuIp).toBe('10.0.0.2');
    expect(r.blocks[0].channels[0].uuidSeed).toBe('seed-1');
    expect(r.blocks[0].channels[0].ccuAuth).toBeUndefined();
  });

  it('moving to another bridge drops the identity seed (like the dialog editor)', () => {
    const r = processApply(state(), { revision: rev(), ops: [{ op: 'set', address: 'AAA:1', name: 'Licht', service: 'SwitchAccessory', bridgeIndex: 1 }] });
    expect(r.ok).toBe(true);
    expect(r.blocks[0].channels.map((c: any) => c.address)).toEqual(['BBB:3']);
    expect(r.blocks[1].channels).toEqual([{ address: 'AAA:1', name: 'Licht', service: 'SwitchAccessory', instance: 'i1', settings: { x: 1 } }]);
  });

  it('adds a new channel, removes one, and checks variants', () => {
    const r = processApply(state(), { revision: rev(), ops: [
      { op: 'set', address: 'CCC:2', name: 'Neu', service: 'BlindAccessory', subtype: 'slats', bridgeIndex: 0 },
      { op: 'remove', address: 'BBB:3' },
    ] });
    expect(r.ok).toBe(true);
    expect(r.blocks[0].channels.map((c: any) => c.address)).toEqual(['AAA:1', 'CCC:2']);
    expect(r.blocks[0].channels[1]).toEqual({ address: 'CCC:2', name: 'Neu', service: 'BlindAccessory', subtype: 'slats' });
  });

  it.each([
    ['unknown service', { op: 'set', address: 'AAA:1', name: 'x', service: 'Nope', bridgeIndex: 0 }],
    ['bad variant', { op: 'set', address: 'BBB:3', name: 'x', service: 'BlindAccessory', subtype: 'nope', bridgeIndex: 0 }],
    ['variant on a service without variants', { op: 'set', address: 'AAA:1', name: 'x', service: 'SwitchAccessory', subtype: 'blind', bridgeIndex: 0 }],
    ['bridge out of range', { op: 'set', address: 'AAA:1', name: 'x', service: 'SwitchAccessory', bridgeIndex: 2 }],
    ['empty name', { op: 'set', address: 'AAA:1', name: '   ', service: 'SwitchAccessory', bridgeIndex: 0 }],
    ['bad address', { op: 'set', address: '<script>', name: 'x', service: 'SwitchAccessory', bridgeIndex: 0 }],
    ['unknown op', { op: 'drop', address: 'AAA:1' }],
    ['remove of an unknown channel', { op: 'remove', address: 'ZZZ:9' }],
  ])('rejects %s', (_label, op) => {
    const r = processApply(state(), { revision: rev(), ops: [op] });
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
    expect(typeof r.error).toBe('string');
  });

  it('accepts no variant on a service with variants (default variant, like the dialog editor)', () => {
    const r = processApply(state(), { revision: rev(), ops: [{ op: 'set', address: 'BBB:3', name: 'Rollo 2', service: 'BlindAccessory', bridgeIndex: 0 }] });
    expect(r.ok).toBe(true);
    expect(r.blocks[0].channels[1]).toEqual({ address: 'BBB:3', name: 'Rollo 2', service: 'BlindAccessory' });
  });

  it('rejects two ops for the same channel and a non-array ops', () => {
    const op = { op: 'remove', address: 'AAA:1' };
    expect(processApply(state(), { revision: rev(), ops: [op, op] })).toMatchObject({ ok: false, code: 'invalid' });
    expect(processApply(state(), { revision: rev(), ops: 'x' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(processApply(state(), null)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('refuses writes while the service list is not loaded', () => {
    const s = { ...state(), services: { channelServices: [] } };
    const r = processApply(s, { revision: rev(), ops: [{ op: 'set', address: 'AAA:1', name: 'x', service: 'SwitchAccessory', bridgeIndex: 0 }] });
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('keptFields (shared with the dialog editor)', () => {
  it('keeps untouched fields and drops uuidSeed when the bridge changes', () => {
    const entry = { address: 'a', name: 'n', uuidSeed: 's', instance: 'i' };
    expect(keptFields(entry, true, ['address', 'name'])).toEqual({ uuidSeed: 's', instance: 'i' });
    expect(keptFields(entry, false, ['address', 'name'])).toEqual({ instance: 'i' });
    expect(keptFields(null, true, [])).toEqual({});
  });
});

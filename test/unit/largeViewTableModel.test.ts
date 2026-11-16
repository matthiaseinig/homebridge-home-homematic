import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser ES module without types
import { buildRows, computeOps, enabledDefaults, isChanged, matchesFilter, matchesSearch, variantFor } from '../../homebridge-ui/large-view/table-model.js';
// @ts-expect-error plain browser ES module without types
import { configRevision, processApply } from '../../homebridge-ui/public/large-view-host.js';

const SERVICES = [
  { key: 'SwitchAccessory', description: 'Schalter', channelTypes: ['SWITCH_VIRTUAL_RECEIVER'], variants: [] },
  { key: 'BlindAccessory', description: 'Rollladen', channelTypes: ['BLIND_VIRTUAL_RECEIVER'], variants: [{ id: 'blind', label: 'Blind' }, { id: 'slats', label: 'Slats' }] },
];

const snapshot = {
  blocks: [
    { name: 'Main', channels: [
      { address: 'AAA:1', name: 'Licht', service: 'SwitchAccessory' },
      { address: 'OLD:1', service: 'SwitchAccessory', settings: { name: 'Alt' } },
    ] },
    { name: 'Keller', channels: [] },
  ],
  devices: [
    { name: 'Wohnzimmer Schalter', type: 'HmIP-BSM', channels: [{ address: 'AAA:1', name: 'ch1', type: 'SWITCH_VIRTUAL_RECEIVER' }] },
    { name: 'Rollo Küche', type: 'HmIP-BROLL', channels: [{ address: 'BBB:4', name: 'Rollo', type: 'BLIND_VIRTUAL_RECEIVER' }] },
  ],
  services: SERVICES,
};

describe('large view table model', () => {
  it('lists discovered and configured-but-missing channels with their configured state', () => {
    const rows = buildRows(snapshot);
    expect(rows.map((r: any) => r.address)).toEqual(['BBB:4', 'AAA:1', 'OLD:1']);
    const aaa = rows.find((r: any) => r.address === 'AAA:1');
    expect(aaa.base).toEqual({ inHK: true, name: 'Licht', service: 'SwitchAccessory', subtype: '', bridgeIndex: 0 });
    const old = rows.find((r: any) => r.address === 'OLD:1');
    expect(old).toMatchObject({ discovered: false, base: { inHK: true, name: 'Alt' } });
    expect(rows.find((r: any) => r.address === 'BBB:4').base.inHK).toBe(false);
  });

  it('switching a channel on picks the first matching service and variant', () => {
    const row = buildRows(snapshot).find((r: any) => r.address === 'BBB:4');
    expect(enabledDefaults(row, SERVICES)).toEqual({ inHK: true, name: 'Rollo', service: 'BlindAccessory', subtype: 'blind', bridgeIndex: 0 });
    expect(variantFor(SERVICES, 'BlindAccessory', 'slats')).toBe('slats');
    expect(variantFor(SERVICES, 'BlindAccessory', 'nope')).toBe('blind');
    expect(variantFor(SERVICES, 'SwitchAccessory', 'blind')).toBe('');
  });

  it('computes set and remove operations that the dialog accepts', () => {
    const rows = buildRows(snapshot);
    const byAddr = new Map(rows.map((r: any) => [r.address, r]));
    const drafts = new Map<string, any>([
      ['AAA:1', { ...byAddr.get('AAA:1').base, name: ' Licht Wohnzimmer ', bridgeIndex: 1 }],
      ['BBB:4', enabledDefaults(byAddr.get('BBB:4'), SERVICES)],
      ['OLD:1', { ...byAddr.get('OLD:1').base, inHK: false }],
    ]);
    const ops = computeOps(rows, drafts);
    expect(ops).toEqual([
      { op: 'set', address: 'BBB:4', name: 'Rollo', service: 'BlindAccessory', subtype: 'blind', bridgeIndex: 0 },
      { op: 'set', address: 'AAA:1', name: 'Licht Wohnzimmer', service: 'SwitchAccessory', bridgeIndex: 1 },
      { op: 'remove', address: 'OLD:1' },
    ]);
    // Round trip through the dialog side.
    const blocks = [
      { platform: 'HomematicHap', name: 'Main', ccuAuth: { password: 'pw' }, channels: snapshot.blocks[0]!.channels },
      { platform: 'HomematicHap', name: 'Keller', ccuAuth: { password: 'pw' }, channels: [] },
    ];
    const r = processApply({ blocks, services: { channelServices: SERVICES } }, { revision: configRevision(blocks), ops });
    expect(r.ok).toBe(true);
    expect(r.blocks[0].channels.map((c: any) => c.address)).toEqual(['BBB:4']);
    expect(r.blocks[1].channels.map((c: any) => c.address)).toEqual(['AAA:1']);
  });

  it('an unchanged draft or an off-to-off toggle produces no operation', () => {
    const rows = buildRows(snapshot);
    const bbb = rows.find((r: any) => r.address === 'BBB:4');
    expect(isChanged(bbb.base, { ...bbb.base, name: 'x' })).toBe(false);
    expect(computeOps(rows, new Map([['AAA:1', rows.find((r: any) => r.address === 'AAA:1').base]]))).toEqual([]);
  });

  it('search covers name, device, address, type and service; filters work', () => {
    const rows = buildRows(snapshot);
    const aaa = rows.find((r: any) => r.address === 'AAA:1');
    expect(matchesSearch(aaa, aaa.base, SERVICES, 'wohnzimmer')).toBe(true);
    expect(matchesSearch(aaa, aaa.base, SERVICES, 'schalter')).toBe(true);
    expect(matchesSearch(aaa, aaa.base, SERVICES, 'aaa:1')).toBe(true);
    expect(matchesSearch(aaa, aaa.base, SERVICES, 'rollo')).toBe(false);
    expect(matchesSearch(aaa, aaa.base, SERVICES, '  ')).toBe(true);
    expect(matchesFilter(aaa, aaa.base, 'hk')).toBe(true);
    expect(matchesFilter(aaa, aaa.base, 'nohk')).toBe(false);
    expect(matchesFilter(aaa, aaa.base, 'changed')).toBe(false);
    expect(matchesFilter(aaa, { ...aaa.base, name: 'y' }, 'changed')).toBe(true);
    expect(matchesFilter(aaa, aaa.base, 'all')).toBe(true);
  });
});

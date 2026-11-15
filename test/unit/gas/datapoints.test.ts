import { describe, expect, it } from 'vitest';
import { checkDatapoints, describedDatapoints } from '../../../src/gas/datapoints.js';

const settings = { counterDatapoint: 'GAS_ENERGY_COUNTER', flowDatapoint: 'GAS_POWER', channel: 1 };

describe('paramset description', () => {
  it('reads lists (NAME, ID or name) and objects keyed by name, skipping junk', () => {
    const list = describedDatapoints([
      { NAME: 'GAS_ENERGY_COUNTER', UNIT: 'm3' },
      { ID: 'GAS_POWER', UNIT: 5 },
      { name: 'BOOT' },
      { NAME: 'bad name' },
      null,
      'x',
    ]);
    expect([...list]).toEqual([
      ['GAS_ENERGY_COUNTER', 'm3'],
      ['GAS_POWER', null],
      ['BOOT', null],
    ]);
    expect([...describedDatapoints({ GAS_POWER: { UNIT: 'm3/h' }, ENERGY_COUNTER: null })]).toEqual(
      [
        ['GAS_POWER', 'm3/h'],
        ['ENERGY_COUNTER', null],
      ],
    );
    expect(describedDatapoints(null).size).toBe(0);
    expect(describedDatapoints('x').size).toBe(0);
  });

  it('says which datapoints exist, with units', () => {
    const ok = checkDatapoints(
      [{ NAME: 'GAS_ENERGY_COUNTER' }, { NAME: 'GAS_POWER', UNIT: 'm3' }],
      settings,
    );
    expect(ok).toMatchObject({ checked: true, found: true, units: { counter: null, flow: 'm3' } });
    expect(ok.messages![0]).toBe('channel 1 has GAS_ENERGY_COUNTER (no unit) and GAS_POWER (m3).');
  });

  it('lists at most 30 other datapoints and copes with an empty description', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      NAME: `DP_${String(i).padStart(2, '0')}`,
    }));
    const r = checkDatapoints(many, settings);
    expect(r.found).toBe(false);
    expect(r.messages![0]).toContain('has no GAS_ENERGY_COUNTER and GAS_POWER');
    expect(r.messages![0]).toContain('DP_29, ...');
    expect(r.messages![0]).not.toContain('DP_30');
    expect(checkDatapoints([], settings).messages![0]).toContain('it has no datapoints');
  });
});

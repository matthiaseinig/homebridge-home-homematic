import { describe, expect, it } from 'vitest';
import type { MeterReading } from '../../../src/gas/config.js';
import {
  applicableReadings,
  displayedReading,
  localTimeMs,
  readingDrift,
  type GasHistoryView,
} from '../../../src/gas/readings.js';

const TZ = 'Europe/Berlin';

/** An in-memory history: day totals and 5 minute rows per local day. */
function view(
  days: Record<string, number>,
  rows: Record<string, Array<[number, number]>> = {},
): GasHistoryView {
  return {
    days: async (from, to) => new Map(Object.entries(days).filter(([d]) => d >= from && d <= to)),
    rows: async (day) => rows[day] ?? [],
  };
}

const at = (day: string, time: string): number => localTimeMs(day, time, TZ) / 1000;

describe('local wall time', () => {
  it('is DST aware', () => {
    expect(new Date(localTimeMs('2026-01-10', '10:00', TZ)).toISOString()).toBe(
      '2026-01-10T09:00:00.000Z',
    );
    expect(new Date(localTimeMs('2026-07-10', '10:00', TZ)).toISOString()).toBe(
      '2026-07-10T08:00:00.000Z',
    );
    expect(new Date(localTimeMs('2026-03-29', '12:00', TZ)).toISOString()).toBe(
      '2026-03-29T10:00:00.000Z',
    );
    expect(new Date(localTimeMs('2026-10-25', '12:00', TZ)).toISOString()).toBe(
      '2026-10-25T11:00:00.000Z',
    );
  });
});

describe('meter readings', () => {
  const now = localTimeMs('2026-11-15', '12:00', TZ);

  it('applies readings from their moment on; one without a time once its day began', () => {
    const readings: MeterReading[] = [
      { date: '2026-11-10', m3: 1 },
      { date: '2026-11-15', time: '11:59', m3: 2 },
      { date: '2026-11-15', time: '12:01', m3: 3 },
      { date: '2026-11-15', m3: 4 },
      { date: '2026-11-16', m3: 5 },
    ];
    expect(applicableReadings(readings, now, TZ).map((r) => r.m3)).toEqual([1, 2, 4]);
  });

  it('shows the device counter source when no reading applies', async () => {
    expect(await displayedReading(view({}), [], now, TZ)).toBeUndefined();
    expect(
      await displayedReading(view({}), [{ date: '2026-12-01', m3: 9 }], now, TZ),
    ).toBeUndefined();
  });

  it('adds the days after an end of day reading, including today so far, and never rewrites them', async () => {
    const v = view({ '2026-11-10': 5, '2026-11-11': 1.5, '2026-11-14': 2, '2026-11-15': 0.75 });
    const shown = await displayedReading(v, [{ date: '2026-11-10', m3: 1000 }], now, TZ);
    expect(shown).toEqual({ reading: { date: '2026-11-10', m3: 1000 }, m3: 1004.25, exact: true });
    // a reading taken today at the end of the day adds nothing yet
    expect((await displayedReading(v, [{ date: '2026-11-15', m3: 2000 }], now, TZ))!.m3).toBe(2000);
  });

  it('splits the reading day and today at the reading time using the 5 minute rows', async () => {
    const rows = {
      '2026-11-14': [
        [at('2026-11-14', '07:55'), 0.5],
        [at('2026-11-14', '08:00'), 0.25],
        [at('2026-11-14', '20:00'), 0.25],
      ] as Array<[number, number]>,
      '2026-11-15': [
        [at('2026-11-15', '06:00'), 0.1],
        [at('2026-11-15', '10:00'), 0.2],
      ] as Array<[number, number]>,
    };
    const v = view({ '2026-11-14': 1, '2026-11-15': 0.3 }, rows);
    // taken on 2026-11-14 at 08:00: the 08:00 and 20:00 buckets and today count
    const a = await displayedReading(v, [{ date: '2026-11-14', time: '08:00', m3: 100 }], now, TZ);
    expect(a).toMatchObject({ m3: 100.8, exact: true });
    // taken today at 08:00: only the 10:00 bucket
    const b = await displayedReading(v, [{ date: '2026-11-15', time: '08:00', m3: 200 }], now, TZ);
    expect(b).toMatchObject({ m3: 200.2, exact: true });
  });

  it('is marked inexact when a reading day had consumption but its rows are gone', async () => {
    const v = view({ '2026-01-05': 4, '2026-01-06': 2 });
    const shown = await displayedReading(
      v,
      [{ date: '2026-01-05', time: '12:00', m3: 50 }],
      now,
      TZ,
    );
    expect(shown).toMatchObject({ m3: 52, exact: false });
  });

  it('reports the drift of each reading against the previous one plus the recorded m³', async () => {
    const rows = {
      '2026-11-12': [
        [at('2026-11-12', '06:00'), 1],
        [at('2026-11-12', '18:00'), 2],
      ] as Array<[number, number]>,
    };
    const v = view({ '2026-11-10': 9, '2026-11-11': 4, '2026-11-12': 3, '2026-11-13': 5 }, rows);
    const drift = await readingDrift(
      v,
      [
        { date: '2026-11-10', m3: 1000 },
        { date: '2026-11-12', time: '12:00', m3: 1005.5 },
        { date: '2026-11-13', m3: 1012 },
        { date: '2026-11-13', time: '23:00', m3: 1011 }, // same day, earlier than the end of day: sorted first by config
        { date: '2026-12-01', m3: 2000 }, // not yet applicable
      ].sort((a, b) =>
        `${a.date} ${a.time ?? '24:00'}`.localeCompare(`${b.date} ${b.time ?? '24:00'}`),
      ),
      now,
      TZ,
    );
    expect(drift).toEqual([
      // 1000 + 4 (11-11) + 1 (11-12 before 12:00) = 1005
      {
        date: '2026-11-12',
        time: '12:00',
        m3: 1005.5,
        expectedM3: 1005,
        driftM3: 0.5,
        exact: true,
      },
      // 1005.5 + 2 (11-12 after 12:00) + 11-13 until 23:00 (no rows, day had 5: unknown split)
      {
        date: '2026-11-13',
        time: '23:00',
        m3: 1011,
        expectedM3: 1007.5,
        driftM3: 3.5,
        exact: false,
      },
      // end of 11-13 after 23:00 on the same day: unknown split again
      { date: '2026-11-13', time: null, m3: 1012, expectedM3: 1011, driftM3: 1, exact: false },
    ]);
    expect(await readingDrift(v, [{ date: '2026-11-10', m3: 1 }], now, TZ)).toEqual([]);
  });

  it('adds nothing between two end of day readings of the same day', async () => {
    const v = view({ '2026-11-10': 9 });
    const drift = await readingDrift(
      v,
      [
        { date: '2026-11-09', m3: 10 },
        { date: '2026-11-10', m3: 19 },
      ],
      now,
      TZ,
    );
    expect(drift[0]).toMatchObject({ expectedM3: 19, driftM3: 0, exact: true });
  });
});

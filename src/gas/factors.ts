import type { FactorPeriod } from './config.js';

export interface FactorDefaults {
  calorificValue: number;
  zNumber: number;
}

export interface DayFactor {
  /** kWh per m³: calorific value x Zustandszahl. */
  kwhPerM3: number;
  calorificValue: number;
  zNumber: number;
  source: 'default' | 'period';
}

export interface PeriodRow {
  period: string;
  m3: number;
  kwh: number;
  /** kWh / m³ of the period (the plain factor when m³ is 0). */
  factor: number;
}

export interface SummedRow extends PeriodRow {
  /** Every factor that applied to one of the period's days, ascending. */
  factors: number[];
}

export const round = (n: number, d: number): number => Math.round(n * 10 ** d) / 10 ** d;
export const roundM3 = (n: number): number => round(n, 3);
export const roundKwh = (n: number): number => round(n, 3);
export const roundFactor = (n: number): number => round(n, 4);

/**
 * kWh conversion of the gas meter. Periods are validated, sorted and
 * non-overlapping (see the config); a day outside every period uses the
 * defaults. Nothing is stored: kWh are always computed when read.
 */
export class GasFactors {
  constructor(
    private readonly defaults: FactorDefaults,
    private readonly periods: readonly FactorPeriod[],
  ) {}

  /** The factor of the local day `day` (`YYYY-MM-DD`). */
  forDay(day: string): DayFactor {
    const p = this.periods.find((x) => x.from <= day && (x.to === undefined || day <= x.to));
    const calorificValue = p?.calorificValue ?? this.defaults.calorificValue;
    const zNumber = p?.zNumber ?? this.defaults.zNumber;
    return {
      kwhPerM3: roundFactor(calorificValue * zNumber),
      calorificValue,
      zNumber,
      source: p ? 'period' : 'default',
    };
  }

  /** One day: m³, kWh and the factor used. */
  day(period: string, m3: number): PeriodRow {
    const f = this.forDay(period).kwhPerM3;
    return { period, m3: roundM3(m3), kwh: roundKwh(m3 * f), factor: f };
  }

  /**
   * Days summed into periods of `len` characters of the day key (7: months,
   * 4: years). Each day is converted with its own factor.
   */
  sum(days: ReadonlyArray<{ date: string; m3: number }>, len: 4 | 7): SummedRow[] {
    const acc = new Map<string, { m3: number; kwh: number; factors: Set<number> }>();
    for (const d of days) {
      const key = d.date.slice(0, len);
      const f = this.forDay(d.date).kwhPerM3;
      const a = acc.get(key) ?? { m3: 0, kwh: 0, factors: new Set<number>() };
      a.m3 += d.m3;
      a.kwh += d.m3 * f;
      a.factors.add(f);
      acc.set(key, a);
    }
    return [...acc]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, a]) => {
        const factors = [...a.factors].sort((x, y) => x - y);
        return {
          period,
          m3: roundM3(a.m3),
          kwh: roundKwh(a.kwh),
          factor: a.m3 > 0 ? roundFactor(a.kwh / a.m3) : (factors[0] ?? 0),
          factors,
        };
      });
  }
}

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
export declare const round: (n: number, d: number) => number;
export declare const roundM3: (n: number) => number;
export declare const roundKwh: (n: number) => number;
export declare const roundFactor: (n: number) => number;
/**
 * kWh conversion of the gas meter. Periods are validated, sorted and
 * non-overlapping (see the config); a day outside every period uses the
 * defaults. Nothing is stored: kWh are always computed when read.
 */
export declare class GasFactors {
    private readonly defaults;
    private readonly periods;
    constructor(defaults: FactorDefaults, periods: readonly FactorPeriod[]);
    /** The factor of the local day `day` (`YYYY-MM-DD`). */
    forDay(day: string): DayFactor;
    /** One day: m³, kWh and the factor used. */
    day(period: string, m3: number): PeriodRow;
    /**
     * Days summed into periods of `len` characters of the day key (7: months,
     * 4: years). Each day is converted with its own factor.
     */
    sum(days: ReadonlyArray<{
        date: string;
        m3: number;
    }>, len: 4 | 7): SummedRow[];
}

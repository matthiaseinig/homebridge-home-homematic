export const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
export const roundM3 = (n) => round(n, 3);
export const roundKwh = (n) => round(n, 3);
export const roundFactor = (n) => round(n, 4);
/**
 * kWh conversion of the gas meter. Periods are validated, sorted and
 * non-overlapping (see the config); a day outside every period uses the
 * defaults. Nothing is stored: kWh are always computed when read.
 */
export class GasFactors {
    defaults;
    periods;
    constructor(defaults, periods) {
        this.defaults = defaults;
        this.periods = periods;
    }
    /** The factor of the local day `day` (`YYYY-MM-DD`). */
    forDay(day) {
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
    day(period, m3) {
        const f = this.forDay(period).kwhPerM3;
        return { period, m3: roundM3(m3), kwh: roundKwh(m3 * f), factor: f };
    }
    /**
     * Days summed into periods of `len` characters of the day key (7: months,
     * 4: years). Each day is converted with its own factor.
     */
    sum(days, len) {
        const acc = new Map();
        for (const d of days) {
            const key = d.date.slice(0, len);
            const f = this.forDay(d.date).kwhPerM3;
            const a = acc.get(key) ?? { m3: 0, kwh: 0, factors: new Set() };
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
//# sourceMappingURL=factors.js.map
/**
 * HomeKit definitions of the gas meter: the `Gas Meter` service and its
 * custom characteristics. The UUIDs were generated once for the Home app
 * contract and are shared with the companion app; never change or reuse
 * one. The contract (units, ranges, valid bits, sources) is
 * docs/GAS-METER.md and must be kept in sync with this file.
 *
 * UUID scheme: suffix `-2128-484C-867A-5E08EB2F0F54`, `F7A0xxxx` for
 * characteristics and `F7A1xxxx` for services.
 */
export declare const UUID_SUFFIX = "-2128-484C-867A-5E08EB2F0F54";
export type CharFormat = 'float' | 'uint32' | 'bool';
export interface CharDef {
    readonly uuid: string;
    /** HAP display name of the characteristic. */
    readonly name: string;
    readonly format: CharFormat;
    /** Contract unit (documentation only; none of these has a HAP unit). */
    readonly unit?: string;
    readonly min?: number;
    readonly max?: number;
    /** Values are rounded to this many decimals before they reach HAP. */
    readonly decimals?: number;
}
export declare const CHARS: {
    readonly ValidFields: {
        readonly format: "uint32";
        readonly unit: "bit mask";
        readonly min: 0;
        readonly max: 4294967295;
        readonly uuid: string;
        readonly name: "Valid Fields";
    };
    readonly LastUpdate: {
        readonly format: "uint32";
        readonly unit: "s since 1970-01-01 UTC";
        readonly min: 0;
        readonly max: 4294967295;
        readonly uuid: string;
        readonly name: "Last Update";
    };
    readonly GasFlow: {
        readonly format: "float";
        readonly unit: "m³/h";
        readonly min: 0;
        readonly max: 1000;
        readonly decimals: 3;
        readonly uuid: string;
        readonly name: "Gas Flow";
    };
    readonly GasMeterReading: {
        readonly format: "float";
        readonly unit: "m³";
        readonly min: 0;
        readonly max: 1000000000;
        readonly decimals: 3;
        readonly uuid: string;
        readonly name: "Meter Reading";
    };
    readonly GasToday: {
        readonly format: "float";
        readonly unit: "m³";
        readonly min: 0;
        readonly max: 1000000000;
        readonly decimals: 3;
        readonly uuid: string;
        readonly name: "Gas Today";
    };
    readonly GasYesterday: {
        readonly format: "float";
        readonly unit: "m³";
        readonly min: 0;
        readonly max: 1000000000;
        readonly decimals: 3;
        readonly uuid: string;
        readonly name: "Gas Yesterday";
    };
    readonly GasMonth: {
        readonly format: "float";
        readonly unit: "m³";
        readonly min: 0;
        readonly max: 1000000000;
        readonly decimals: 3;
        readonly uuid: string;
        readonly name: "Gas Month";
    };
    readonly GasMonthKwh: {
        readonly format: "float";
        readonly unit: "kWh";
        readonly min: 0;
        readonly max: 1000000000;
        readonly decimals: 3;
        readonly uuid: string;
        readonly name: "Gas Month kWh";
    };
    readonly GasFactor: {
        readonly format: "float";
        readonly unit: "kWh/m³";
        readonly min: 0;
        readonly max: 100;
        readonly decimals: 4;
        readonly uuid: string;
        readonly name: "Factor";
    };
    readonly GasReachable: {
        readonly format: "bool";
        readonly uuid: string;
        readonly name: "Reachable";
    };
    readonly GasLowBattery: {
        readonly format: "bool";
        readonly uuid: string;
        readonly name: "Low Battery";
    };
};
export type CharKey = keyof typeof CHARS;
export declare const GAS_SERVICE: {
    readonly uuid: string;
    readonly name: "Gas Meter";
    readonly chars: readonly CharKey[];
    /**
     * Bit index in `ValidFields` for every characteristic whose value can be
     * missing. A cleared bit means "not known on the last poll". Bits are
     * stable: never renumber, only add.
     */
    readonly validBits: Readonly<Partial<Record<CharKey, number>>>;
};
/** A value ready for a characteristic, before sanitising. `undefined` means "not known". */
export type RawValue = number | boolean | undefined;
export type CharValues = Partial<Record<CharKey, RawValue>>;
/**
 * Coerce a value into something HAP accepts for `def`: numbers are rounded
 * to the declared decimals and clamped to the declared range.
 */
export declare function sanitize(def: CharDef, raw: number | boolean): number | boolean;
/** The HAP value a characteristic holds before it ever received a reading. */
export declare function initialValue(def: CharDef): number | boolean;
/** The `ValidFields` bit mask for `values`. */
export declare function validMask(values: CharValues): number;

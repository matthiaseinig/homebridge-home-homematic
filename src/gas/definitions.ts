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

export const UUID_SUFFIX = '-2128-484C-867A-5E08EB2F0F54';
const charUuid = (n: string): string => `F7A0${n}${UUID_SUFFIX}`;
const serviceUuid = (n: string): string => `F7A1${n}${UUID_SUFFIX}`;

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

const TIMESTAMP = { format: 'uint32', unit: 's since 1970-01-01 UTC', min: 0, max: 4_294_967_295 } as const;
const MASK = { format: 'uint32', unit: 'bit mask', min: 0, max: 4_294_967_295 } as const;
const ENERGY = { format: 'float', unit: 'kWh', min: 0, max: 1_000_000_000, decimals: 3 } as const;
const GAS_VOLUME = { format: 'float', unit: 'm³', min: 0, max: 1_000_000_000, decimals: 3 } as const;
const GAS_FLOW = { format: 'float', unit: 'm³/h', min: 0, max: 1000, decimals: 3 } as const;
const GAS_FACTOR = { format: 'float', unit: 'kWh/m³', min: 0, max: 100, decimals: 4 } as const;
const FLAG = { format: 'bool' } as const;

export const CHARS = {
  ValidFields: { uuid: charUuid('0001'), name: 'Valid Fields', ...MASK },
  LastUpdate: { uuid: charUuid('0002'), name: 'Last Update', ...TIMESTAMP },
  GasFlow: { uuid: charUuid('00A0'), name: 'Gas Flow', ...GAS_FLOW },
  GasMeterReading: { uuid: charUuid('00A1'), name: 'Meter Reading', ...GAS_VOLUME },
  GasToday: { uuid: charUuid('00A2'), name: 'Gas Today', ...GAS_VOLUME },
  GasYesterday: { uuid: charUuid('00A3'), name: 'Gas Yesterday', ...GAS_VOLUME },
  GasMonth: { uuid: charUuid('00A4'), name: 'Gas Month', ...GAS_VOLUME },
  GasMonthKwh: { uuid: charUuid('00A5'), name: 'Gas Month kWh', ...ENERGY },
  GasFactor: { uuid: charUuid('00A6'), name: 'Factor', ...GAS_FACTOR },
  GasReachable: { uuid: charUuid('00A7'), name: 'Reachable', ...FLAG },
  GasLowBattery: { uuid: charUuid('00A8'), name: 'Low Battery', ...FLAG },
} as const satisfies Record<string, CharDef>;

export type CharKey = keyof typeof CHARS;

export const GAS_SERVICE = {
  uuid: serviceUuid('0005'),
  name: 'Gas Meter',
  chars: [
    'GasFlow',
    'GasMeterReading',
    'GasToday',
    'GasYesterday',
    'GasMonth',
    'GasMonthKwh',
    'GasFactor',
    'GasReachable',
    'GasLowBattery',
    'ValidFields',
    'LastUpdate',
  ] as readonly CharKey[],
  /**
   * Bit index in `ValidFields` for every characteristic whose value can be
   * missing. A cleared bit means "not known on the last poll". Bits are
   * stable: never renumber, only add.
   */
  validBits: {
    GasFlow: 0,
    GasMeterReading: 1,
    GasToday: 2,
    GasYesterday: 3,
    GasMonth: 4,
    GasMonthKwh: 5,
    GasFactor: 6,
    GasReachable: 7,
    GasLowBattery: 8,
  } as Readonly<Partial<Record<CharKey, number>>>,
} as const;

/** A value ready for a characteristic, before sanitising. `undefined` means "not known". */
export type RawValue = number | boolean | undefined;

export type CharValues = Partial<Record<CharKey, RawValue>>;

/**
 * Coerce a value into something HAP accepts for `def`: numbers are rounded
 * to the declared decimals and clamped to the declared range.
 */
export function sanitize(def: CharDef, raw: number | boolean): number | boolean {
  if (def.format === 'bool') return raw === true;
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  const factor = 10 ** (def.format === 'float' ? (def.decimals ?? 3) : 0);
  const rounded = Math.round(n * factor) / factor;
  const min = def.min ?? Number.NEGATIVE_INFINITY;
  const max = def.max ?? Number.POSITIVE_INFINITY;
  // `+ 0` folds a negative zero produced by rounding into a plain 0.
  return Math.min(max, Math.max(min, rounded)) + 0;
}

/** The HAP value a characteristic holds before it ever received a reading. */
export function initialValue(def: CharDef): number | boolean {
  return def.format === 'bool' ? false : Math.min(def.max ?? 0, Math.max(def.min ?? 0, 0));
}

/** The `ValidFields` bit mask for `values`. */
export function validMask(values: CharValues): number {
  let mask = 0;
  for (const [key, bit] of Object.entries(GAS_SERVICE.validBits) as Array<[CharKey, number]>) {
    if (values[key] !== undefined) mask |= 2 ** bit;
  }
  return mask >>> 0;
}

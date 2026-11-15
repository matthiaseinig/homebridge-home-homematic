import type { Characteristic, CharacteristicProps, HAP, Service, WithUUID } from 'homebridge';
import { CHARS, GAS_SERVICE, initialValue, sanitize, validMask, type CharKey, type CharValues } from './definitions.js';

/** Seed of the gas meter accessory UUID; never change it (HomeKit identity). */
export const GAS_ACCESSORY_SEED = 'homebridge-homematic-hap:gas-meter';
export const GAS_SUBTYPE = 'gas-meter';
export const GAS_MANUFACTURER = 'HomeMatic HAP';
export const GAS_MODEL = 'Gas Meter';
export const GAS_SERIAL = 'gas-meter';

type CharCtor = WithUUID<new () => Characteristic>;
type ServiceCtor = WithUUID<new (displayName?: string, subtype?: string) => Service>;

/** What the gas meter needs of an accessory: a Homebridge PlatformAccessory or a plain HAP Accessory. */
export interface GasAccessory {
  readonly services: Service[];
  getService(name: string | WithUUID<typeof Service>): Service | undefined;
  addService(service: Service): Service;
}

interface GasHapTypes {
  char(key: CharKey): CharCtor;
  props(key: CharKey): CharacteristicProps;
  service: ServiceCtor;
}

const cache = new WeakMap<object, GasHapTypes>();

function toProps(hap: HAP, key: CharKey): CharacteristicProps {
  const def = CHARS[key];
  const props: CharacteristicProps = {
    format: def.format === 'float' ? hap.Formats.FLOAT : def.format === 'bool' ? hap.Formats.BOOL : hap.Formats.UINT32,
    // Read and notify only. Nothing of the gas meter is writable.
    perms: [hap.Perms.PAIRED_READ, hap.Perms.NOTIFY],
  };
  if ('min' in def) props.minValue = def.min;
  if ('max' in def) props.maxValue = def.max;
  return props;
}

/** The custom classes, built once per HAP instance (they must extend the HAP classes Homebridge hands over). */
export function gasHapTypes(hap: HAP): GasHapTypes {
  const cached = cache.get(hap);
  if (cached) return cached;
  const chars = new Map<CharKey, CharCtor>();
  const char = (key: CharKey): CharCtor => {
    let ctor = chars.get(key);
    if (!ctor) {
      const def = CHARS[key];
      const p = toProps(hap, key);
      ctor = class extends hap.Characteristic {
        static readonly UUID = def.uuid;
        constructor() {
          super(def.name, def.uuid, { ...p });
          this.value = initialValue(def);
        }
      };
      chars.set(key, ctor);
    }
    return ctor;
  };
  const service = class extends hap.Service {
    static readonly UUID = GAS_SERVICE.uuid;
    constructor(displayName?: string, subtype?: string) {
      super(displayName, GAS_SERVICE.uuid, subtype);
      for (const k of GAS_SERVICE.chars) this.addCharacteristic(char(k));
    }
  };
  const types: GasHapTypes = { char, props: (key) => toProps(hap, key), service };
  cache.set(hap, types);
  return types;
}

/**
 * The `Gas Meter` service on its own accessory. The device address is never
 * exposed (the serial number is the fixed `gas-meter`).
 */
export class GasMeterServices {
  private readonly svc: Service;

  constructor(
    private readonly hap: HAP,
    accessory: GasAccessory,
    name: string,
  ) {
    const info = accessory.getService(hap.Service.AccessoryInformation)
      ?? accessory.addService(new hap.Service.AccessoryInformation());
    info.setCharacteristic(hap.Characteristic.Manufacturer, GAS_MANUFACTURER)
      .setCharacteristic(hap.Characteristic.Model, GAS_MODEL)
      .setCharacteristic(hap.Characteristic.SerialNumber, GAS_SERIAL);
    const types = gasHapTypes(hap);
    const svc = accessory.services.find((s) => s.UUID === GAS_SERVICE.uuid && s.subtype === GAS_SUBTYPE)
      ?? accessory.addService(new types.service(name, GAS_SUBTYPE));
    // A service restored from the Homebridge cache is a plain HAP service: add what is missing, re-apply the props.
    for (const k of GAS_SERVICE.chars) {
      const c = types.char(k);
      const present = svc.characteristics.some((x) => x.UUID === c.UUID);
      const characteristic = present ? svc.getCharacteristic(c) : svc.addCharacteristic(c);
      characteristic.setProps(types.props(k));
    }
    const label = name.slice(0, 64);
    if (svc.getCharacteristic(hap.Characteristic.Name).value !== label) {
      svc.updateCharacteristic(hap.Characteristic.Name, label);
    }
    this.svc = svc;
  }

  /**
   * Push values. `undefined` (not known) leaves the characteristic
   * untouched (a missing value never turns into 0) and clears its bit in
   * `ValidFields`. A characteristic is only updated when its sanitised value
   * changes, so HAP notifies on real changes only.
   */
  apply(values: CharValues): void {
    const types = gasHapTypes(this.hap);
    const withMask: CharValues = { ...values, ValidFields: validMask(values) };
    for (const key of GAS_SERVICE.chars) {
      const raw = withMask[key];
      if (raw === undefined) continue;
      const next = sanitize(CHARS[key], raw);
      const characteristic = this.svc.getCharacteristic(types.char(key));
      if (characteristic.value !== next) characteristic.updateValue(next);
    }
  }
}

import type { Characteristic, CharacteristicProps, HAP, Service, WithUUID } from 'homebridge';
import { type CharKey, type CharValues } from './definitions.js';
/** Seed of the gas meter accessory UUID; never change it (HomeKit identity). */
export declare const GAS_ACCESSORY_SEED = "homebridge-homematic-hap:gas-meter";
export declare const GAS_SUBTYPE = "gas-meter";
export declare const GAS_MANUFACTURER = "HomeMatic HAP";
export declare const GAS_MODEL = "Gas Meter";
export declare const GAS_SERIAL = "gas-meter";
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
/** The custom classes, built once per HAP instance (they must extend the HAP classes Homebridge hands over). */
export declare function gasHapTypes(hap: HAP): GasHapTypes;
/**
 * The `Gas Meter` service on its own accessory. The device address is never
 * exposed (the serial number is the fixed `gas-meter`).
 */
export declare class GasMeterServices {
    private readonly hap;
    private readonly svc;
    constructor(hap: HAP, accessory: GasAccessory, name: string);
    /**
     * Push values. `undefined` (not known) leaves the characteristic
     * untouched (a missing value never turns into 0) and clears its bit in
     * `ValidFields`. A characteristic is only updated when its sanitised value
     * changes, so HAP notifies on real changes only.
     */
    apply(values: CharValues): void;
}
export {};

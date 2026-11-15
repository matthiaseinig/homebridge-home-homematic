import type { HAP } from 'homebridge';
import type { PrefixedLogger } from '../util/logger.js';
import { type SharedCcuSession } from './ccuReader.js';
import type { GasSettings } from './config.js';
import { type GasAccessory } from './hap.js';
import { GasService, type GasServiceDeps } from './service.js';
export declare const GAS_HISTORY_DIR = "gas";
export interface GasMeterOptions {
    settings: GasSettings;
    hap: HAP;
    /** The plugin's shared CCU JSON-RPC session (`CcuClient.api`). */
    session: SharedCcuSession;
    /** CCU host and user, for the backoff fingerprint and for masking error texts. */
    ccu: {
        host: string;
        username?: string;
        password?: string;
    };
    /** The plugin's folder in the Homebridge storage path. */
    storageRoot: string;
    log: PrefixedLogger;
    /** Test hooks. */
    deps?: Partial<Pick<GasServiceDeps, 'now' | 'setTimer' | 'clearTimer'>>;
}
/**
 * The gas meter of one platform block: polling and history (GasService),
 * the HomeKit accessory (on the host bridge or a multi-bridge) and the
 * optional LAN API. It starts independently of the XML-RPC event
 * subscriptions: the device is polled, so a firewalled event port does not
 * block it.
 */
export declare class GasMeter {
    private readonly opts;
    readonly service: GasService;
    private services;
    private last;
    private server;
    /** The bound API port, once listening. */
    apiPort: number | undefined;
    constructor(opts: GasMeterOptions);
    /** The HomeKit UUID of the gas meter accessory. */
    static uuid(hap: HAP): string;
    get name(): string;
    /** Publish the values on `accessory` from now on (host: a PlatformAccessory; multi-bridge: a HAP Accessory). */
    attach(accessory: GasAccessory): void;
    /** A new bridged HAP accessory carrying the gas meter, for a multi-bridge. */
    createBridgedAccessory(): InstanceType<HAP['Accessory']>;
    private apply;
    start(): Promise<void>;
    stop(): Promise<void>;
}

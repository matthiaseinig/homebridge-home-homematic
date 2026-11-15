/**
 * Builds one HAP-NodeJS Bridge for a multi-bridge entry: the bridge
 * accessory with the hap-homematic bridge UUID, and one bridged accessory
 * per mapping, built by the same service handlers as platform accessories.
 * Building has no network side effects; publishing is the host's job.
 * The offline IID check (scripts/iid-check.mjs) uses this directly.
 */
import type { HAP } from 'homebridge';
import type { CcuClient } from '../ccu/CcuClient.js';
import type { GasSettings } from '../gas/config.js';
import type { ChannelService, ProgramService, VariableService } from '../services/types.js';
import type { AccessoryContext, CcuDevice, CcuVariable, MultiBridgeEntry } from '../types.js';
import type { PrefixedLogger } from '../util/logger.js';
import { type HapAccessory } from './BridgedAccessoryHandle.js';
export type HapBridge = InstanceType<HAP['Bridge']>;
type Handler = ChannelService | VariableService | ProgramService;
/** What the CCU reported once at startup; shared by all bridges. */
export interface CcuSnapshot {
    devices: CcuDevice[];
    variables: CcuVariable[];
}
export interface BuiltAccessory {
    kind: AccessoryContext['kind'];
    id: string;
    name: string;
    uuid: string;
    legacyIdentity: boolean;
}
export interface BuiltBridge {
    entry: MultiBridgeEntry;
    bridge: HapBridge;
    accessories: BuiltAccessory[];
    /** Mappings that produced no accessory, with the reason. */
    skipped: Array<{
        kind: AccessoryContext['kind'];
        id: string;
        reason: string;
    }>;
    handlers: Handler[];
}
/** What the bridge builder needs to know of the gas meter. */
export type GasMappingGuard = Pick<GasSettings, 'enabled' | 'address'>;
export interface BuildDeps {
    hap: HAP;
    ccu: CcuClient;
    log: PrefixedLogger;
    version: string;
    /** With the gas meter on, its device is never built from a mapping (see gas/placement.ts). */
    gas?: GasMappingGuard;
    /** Accessories added besides the mappings (the gas meter on its chosen bridge). */
    extraAccessories?: (entry: MultiBridgeEntry) => HapAccessory[];
}
/** hap-homematic created its bridges as `new Bridge(name, <instance id>)`. */
export declare function bridgeUuidFor(hap: HAP, entry: Pick<MultiBridgeEntry, 'bridgeUuid' | 'username'>): string;
export declare function buildBridge(deps: BuildDeps, entry: MultiBridgeEntry, snapshot: CcuSnapshot): BuiltBridge;
export {};

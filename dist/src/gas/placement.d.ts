import type { MultiBridgeConfig } from '../types.js';
import { type GasSettings } from './config.js';
/** Where the gas meter accessory is published. */
export type GasPlacement = {
    kind: 'host';
} | {
    kind: 'bridge';
    name: string;
};
/**
 * `gas.bridge`: `host` is the plugin's own (child) bridge; a name is one of
 * the enabled multi-bridges. Without it: the first enabled multi-bridge whose
 * name contains "Keller", else the host bridge. A name that is not an enabled
 * multi-bridge is an error (the accessory is then not published; polling,
 * history and the API still run).
 */
export declare function resolveGasPlacement(bridge: string | undefined, multiBridge: MultiBridgeConfig | undefined): {
    placement: GasPlacement;
} | {
    error: string;
};
/**
 * Why a channel mapping must not become an accessory while the gas meter is
 * on, else undefined: the gas meter device is owned by the gas block (read
 * only, never written), and a POWERMETER_IGL channel is never published as a
 * power meter Outlet in gas mode (its gas values would show as electric ones).
 */
export declare function gasMappingConflict(gas: Pick<GasSettings, 'enabled' | 'address'> | undefined, mapping: {
    address: string;
    service: string;
}, channelType?: string): string | undefined;

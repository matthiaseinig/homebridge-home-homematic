import type { MultiBridgeConfig } from '../types.js';
import { HOST_PLACEMENT, isGasDevice, type GasSettings } from './config.js';

/** Where the gas meter accessory is published. */
export type GasPlacement = { kind: 'host' } | { kind: 'bridge'; name: string };

const KELLER = /keller/i;

/**
 * `gas.bridge`: `host` is the plugin's own (child) bridge; a name is one of
 * the enabled multi-bridges. Without it: the first enabled multi-bridge whose
 * name contains "Keller", else the host bridge. A name that is not an enabled
 * multi-bridge is an error (the accessory is then not published; polling,
 * history and the API still run).
 */
export function resolveGasPlacement(
  bridge: string | undefined,
  multiBridge: MultiBridgeConfig | undefined,
): { placement: GasPlacement } | { error: string } {
  const enabled = (multiBridge?.bridges ?? []).filter((b) => b.enabled);
  if (bridge === undefined) {
    const keller = enabled.find((b) => KELLER.test(b.name));
    return { placement: keller ? { kind: 'bridge', name: keller.name } : { kind: 'host' } };
  }
  if (bridge.toLowerCase() === HOST_PLACEMENT) return { placement: { kind: 'host' } };
  const match = enabled.find((b) => b.name === bridge);
  if (!match) {
    return { error: 'gas.bridge names no enabled multi-bridge (use "host" or the name of an enabled bridge); the gas meter accessory is not published' };
  }
  return { placement: { kind: 'bridge', name: match.name } };
}

/**
 * Why a channel mapping must not become an accessory while the gas meter is
 * on, else undefined: the gas meter device is owned by the gas block (read
 * only, never written), and a POWERMETER_IGL channel is never published as a
 * power meter Outlet in gas mode (its gas values would show as electric ones).
 */
export function gasMappingConflict(
  gas: Pick<GasSettings, 'enabled' | 'address'> | undefined,
  mapping: { address: string; service: string },
  channelType?: string,
): string | undefined {
  if (!gas?.enabled) return undefined;
  if (isGasDevice(gas, mapping.address)) {
    return 'a channel of the gas meter device is not mapped while gas.enabled is set (the gas meter block reads it, read-only)';
  }
  if (channelType === 'POWERMETER_IGL' && mapping.service === 'PowerMeterAccessory') {
    return 'a POWERMETER_IGL channel is not published as a power meter Outlet while gas.enabled is set';
  }
  return undefined;
}

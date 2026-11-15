/**
 * Writes the slat tilt of one HmIP blind channel. Positions are never routed
 * through here: they go out at once as a plain LEVEL write, as before.
 *
 * HmIP blind actuators (BLIND_VIRTUAL_RECEIVER) accept a lone LEVEL_2 write
 * and ignore it. A COMBINED_PARAMETER write with only the slat part
 * ("L2=<pct>", no L=) changes just the slats and never moves the blind.
 * HomeKit sends a burst of tilt values while the slider is dragged, so tilt
 * changes are debounced and the last value wins.
 *
 * Modes (plugin setting `slatWriteMode`):
 *   combined          debounced COMBINED_PARAMETER "L2=<pct>" (default)
 *   level2-then-stop  debounced LEVEL_2, then STOP=true unless the blind is moving
 *   level2            legacy: LEVEL_2 written at once
 *
 * A failed debounced write is logged once per accessory, reported to the
 * caller (which resets HomeKit's target tilt) and dropped: nothing is kept
 * pending, so nothing is replayed with a later command.
 */
import type { CcuClient } from '../ccu/CcuClient.js';
import type { PrefixedLogger } from '../util/logger.js';
export type SlatWriteMode = 'combined' | 'level2-then-stop' | 'level2';
export declare const SLAT_WRITE_MODES: readonly SlatWriteMode[];
export declare const DEFAULT_SLAT_WRITE_MODE: SlatWriteMode;
export declare const SLAT_DEBOUNCE_MS = 1000;
export interface SlatWriterOptions {
    ccu: CcuClient;
    address: string;
    mode: SlatWriteMode;
    log: PrefixedLogger;
    /** Called after a failed debounced write: reset HomeKit's target tilt. */
    onFailure: () => void;
    /** True while the blind is moving (STOP is then skipped). */
    isMoving: () => boolean;
    debounceMs?: number;
}
export declare class SlatWriter {
    private readonly o;
    private pendingTilt;
    private timer;
    private warned;
    constructor(o: SlatWriterOptions);
    /** Tilt command (0..1). */
    setTilt(fraction: number): Promise<void>;
    dispose(): void;
    private flush;
    private fail;
}

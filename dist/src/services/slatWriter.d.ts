/**
 * Writes position and slat tilt of one HmIP blind channel.
 *
 * HmIP blind actuators (BLIND_VIRTUAL_RECEIVER) accept a lone LEVEL_2 write
 * and ignore it; the slats only move when LEVEL and LEVEL_2 arrive together
 * (COMBINED_PARAMETER "L=<pct>,L2=<pct>"). HomeKit sends position and tilt as
 * separate writes, so tilt changes are debounced (last value wins) and a
 * position change inside the same window is merged into the same write.
 *
 * Modes (plugin setting `slatWriteMode`):
 *   combined          debounced COMBINED_PARAMETER with both values (default)
 *   level2-then-stop  position written at once; tilt debounced, LEVEL_2 then STOP=true
 *   level2            legacy: LEVEL and LEVEL_2 written at once, separately
 */
import type { CcuClient } from '../ccu/CcuClient.js';
import type { PrefixedLogger } from '../util/logger.js';
export type SlatWriteMode = 'combined' | 'level2-then-stop' | 'level2';
export declare const SLAT_WRITE_MODES: readonly SlatWriteMode[];
export declare const DEFAULT_SLAT_WRITE_MODE: SlatWriteMode;
export declare const SLAT_DEBOUNCE_MS = 1000;
export declare class SlatWriter {
    private readonly ccu;
    private readonly address;
    private readonly mode;
    private readonly log;
    private readonly debounceMs;
    private knownLevel;
    private knownTilt;
    private pendingLevel;
    private pendingTilt;
    private timer;
    constructor(ccu: CcuClient, address: string, mode: SlatWriteMode, log: PrefixedLogger, debounceMs?: number);
    /** Last position (0..1) the CCU reported. */
    noteLevel(fraction: number): void;
    /** Last tilt (0..1) the CCU reported. */
    noteTilt(fraction: number): void;
    /** Position command (0..1). */
    setLevel(fraction: number): Promise<void>;
    /** Tilt command (0..1). */
    setTilt(fraction: number): Promise<void>;
    dispose(): void;
    private arm;
    private flush;
    private read;
}

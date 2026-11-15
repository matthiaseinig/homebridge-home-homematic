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
export const SLAT_WRITE_MODES: readonly SlatWriteMode[] = ['combined', 'level2-then-stop', 'level2'];
export const DEFAULT_SLAT_WRITE_MODE: SlatWriteMode = 'combined';
export const SLAT_DEBOUNCE_MS = 1000;

const pct = (fraction: number): number => Math.round(Math.max(0, Math.min(1, fraction)) * 100);

export class SlatWriter {
  private knownLevel: number | undefined;
  private knownTilt: number | undefined;
  private pendingLevel: number | undefined;
  private pendingTilt: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly ccu: CcuClient,
    private readonly address: string,
    private readonly mode: SlatWriteMode,
    private readonly log: PrefixedLogger,
    private readonly debounceMs: number = SLAT_DEBOUNCE_MS,
  ) {}

  /** Last position (0..1) the CCU reported. */
  noteLevel(fraction: number): void {
    this.knownLevel = fraction;
  }

  /** Last tilt (0..1) the CCU reported. */
  noteTilt(fraction: number): void {
    this.knownTilt = fraction;
  }

  /** Position command (0..1). */
  async setLevel(fraction: number): Promise<void> {
    this.knownLevel = fraction;
    if (this.mode !== 'combined') {
      await this.ccu.setValue(this.address, 'LEVEL', fraction);
      return;
    }
    this.pendingLevel = fraction;
    this.arm();
  }

  /** Tilt command (0..1). */
  async setTilt(fraction: number): Promise<void> {
    this.knownTilt = fraction;
    if (this.mode === 'level2') {
      await this.ccu.setValue(this.address, 'LEVEL_2', fraction);
      return;
    }
    this.pendingTilt = fraction;
    this.arm();
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private arm(): void {
    this.dispose();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush().catch((err: Error) => this.log.warn('slat write failed: %s', err.message));
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    const level = this.pendingLevel;
    const tilt = this.pendingTilt;
    this.pendingLevel = undefined;
    this.pendingTilt = undefined;
    if (this.mode === 'level2-then-stop') {
      if (tilt !== undefined) {
        await this.ccu.setValue(this.address, 'LEVEL_2', tilt);
        await this.ccu.setValue(this.address, 'STOP', true);
      }
      return;
    }
    const l = level ?? this.knownLevel ?? await this.read('LEVEL');
    const t = tilt ?? this.knownTilt ?? await this.read('LEVEL_2');
    if (l === undefined || t === undefined) {
      // One side is unknown even after a read: write what was asked for.
      this.log.warn('slat write: %s unknown, writing %s alone', l === undefined ? 'LEVEL' : 'LEVEL_2', l === undefined ? 'LEVEL_2' : 'LEVEL');
      if (level !== undefined) await this.ccu.setValue(this.address, 'LEVEL', level);
      if (tilt !== undefined) await this.ccu.setValue(this.address, 'LEVEL_2', tilt);
      return;
    }
    this.knownLevel = l;
    this.knownTilt = t;
    await this.ccu.setValue(this.address, 'COMBINED_PARAMETER', `L=${pct(l)},L2=${pct(t)}`);
  }

  private async read(datapoint: string): Promise<number | undefined> {
    const raw = await this.ccu.getValue(this.address, datapoint).catch(() => undefined);
    const n = typeof raw === 'number' ? raw : Number(raw);
    return raw === undefined || raw === null || raw === '' || !Number.isFinite(n) ? undefined : n;
  }
}

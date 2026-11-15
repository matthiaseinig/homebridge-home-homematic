/** Last counter value (m³) and when it was read. */
export interface CounterState {
  counter?: number;
  /** Time of the last sample, epoch ms. */
  at?: number;
}

/** Plausibility limits of a counter, in its own unit. */
export interface CounterLimits {
  /** Largest increase per hour of elapsed time. */
  readonly maxPerHour: number;
  /** Added to the allowed increase of every step (counter resolution, clock jitter). */
  readonly slack: number;
  /**
   * A reading of exactly 0 while the baseline is above 0 is held (`hold`)
   * instead of being treated as a reset: the next reading decides whether it
   * was a read glitch (at or above the baseline) or a real restart (below).
   */
  readonly holdZero?: boolean;
  /**
   * A value below the baseline is a reset (the sensor restarted at 0) only
   * when it is below this; a higher value below the baseline is a read glitch
   * and is held like a 0. This also applies to the first reading after a
   * restart of the plugin, which is compared with the saved baseline.
   */
  readonly resetBelow?: number;
}

export interface CounterStep {
  /** Consumption since the previous sample, in the counter's unit. */
  delta: number;
  /** The counter went backwards (sensor restart) and was re-based. */
  reset: boolean;
  /** The counter jumped by more than physically possible, or dropped without a restart; nothing is counted. */
  glitch: boolean;
  /** The reading is held (a 0, or a drop that is no reset): keep the previous baseline, do not store this value. */
  hold?: boolean;
}

/**
 * Consumption since the previous sample from a monotonic counter. The first
 * sample only sets the baseline. A counter below the previous value is a
 * reset (the new value is what was counted since the restart) only when it
 * is below `resetBelow`; otherwise it is held as a glitch. Increases above
 * what `limits` allow in the elapsed time are dropped (the caller re-bases).
 */
export function counterStep(
  prev: CounterState,
  counter: number,
  nowMs: number,
  limits: CounterLimits,
): CounterStep {
  if (prev.counter === undefined || prev.at === undefined) {
    return { delta: 0, reset: false, glitch: false };
  }
  if (limits.holdZero === true && counter === 0 && prev.counter > 0) {
    return { delta: 0, reset: false, glitch: false, hold: true };
  }
  if (limits.resetBelow !== undefined && counter < prev.counter && counter >= limits.resetBelow) {
    return { delta: 0, reset: false, glitch: true, hold: true };
  }
  const max = (limits.maxPerHour * Math.max(0, nowMs - prev.at)) / 3_600_000 + limits.slack;
  const reset = counter < prev.counter;
  const delta = reset ? counter : counter - prev.counter;
  if (delta > max) return { delta: 0, reset, glitch: true };
  return { delta, reset, glitch: false };
}

/**
 * Consumption since the previous sample from a monotonic counter. The first
 * sample only sets the baseline. A counter below the previous value is a
 * reset (the new value is what was counted since the restart) only when it
 * is below `resetBelow`; otherwise it is held as a glitch. Increases above
 * what `limits` allow in the elapsed time are dropped (the caller re-bases).
 */
export function counterStep(prev, counter, nowMs, limits) {
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
    if (delta > max)
        return { delta: 0, reset, glitch: true };
    return { delta, reset, glitch: false };
}
//# sourceMappingURL=counter.js.map
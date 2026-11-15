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
export const SLAT_WRITE_MODES = ['combined', 'level2-then-stop', 'level2'];
export const DEFAULT_SLAT_WRITE_MODE = 'combined';
export const SLAT_DEBOUNCE_MS = 1000;
const pct = (fraction) => Math.round(Math.max(0, Math.min(1, fraction)) * 100);
export class SlatWriter {
    o;
    pendingTilt;
    timer;
    warned = false;
    constructor(o) {
        this.o = o;
    }
    /** Tilt command (0..1). */
    async setTilt(fraction) {
        if (this.o.mode === 'level2') {
            await this.o.ccu.setValue(this.o.address, 'LEVEL_2', fraction);
            return;
        }
        this.pendingTilt = fraction;
        this.dispose();
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.flush().catch((err) => this.fail(err));
        }, this.o.debounceMs ?? SLAT_DEBOUNCE_MS);
        this.timer.unref?.();
    }
    dispose() {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
    async flush() {
        const tilt = this.pendingTilt;
        this.pendingTilt = undefined;
        if (tilt === undefined)
            return;
        const { ccu, address, mode, log } = this.o;
        if (mode === 'combined') {
            await ccu.setValue(address, 'COMBINED_PARAMETER', `L2=${pct(tilt)}`);
            return;
        }
        await ccu.setValue(address, 'LEVEL_2', tilt);
        if (this.o.isMoving()) {
            log.info('slat tilt written; STOP skipped because the blind is moving');
            return;
        }
        await ccu.setValue(address, 'STOP', true);
    }
    fail(err) {
        this.pendingTilt = undefined;
        if (this.warned) {
            this.o.log.debug('slat tilt write failed: %s', err.message);
        }
        else {
            this.warned = true;
            this.o.log.warn('slat tilt write failed (%s); target tilt reset, further failures are logged at debug level', err.message);
        }
        this.o.onFailure();
    }
}
//# sourceMappingURL=slatWriter.js.map
import { AccessoryBase } from '../AccessoryBase.js';
import { normalizeLevelToPercent, percentToLevelFraction } from '../../util/sanitize.js';
const BLIND_CHANNEL_TYPES = [
    'BLIND',
    'BLIND_VIRTUAL_RECEIVER',
    'SHUTTER_VIRTUAL_RECEIVER',
];
/** HmIP virtual receivers; those of wired actuators (DRBL4 style) have a status channel. */
const VIRTUAL_RECEIVER_TYPES = ['BLIND_VIRTUAL_RECEIVER', 'SHUTTER_VIRTUAL_RECEIVER'];
const TRANSMITTER_TYPES = ['BLIND_TRANSMITTER', 'SHUTTER_TRANSMITTER'];
const GROUP_SIZE = 4;
/**
 * Status (transmitter) channel of an HmIP virtual receiver, for layouts where
 * the transmitter is the first channel of a group of four (HmIPW-DRBL4,
 * DRBLI4, DRSI4: 1/5/9/13, each followed by three virtual receivers). It is
 * the nearest preceding BLIND_/SHUTTER_TRANSMITTER of the same device taken
 * from `channels`, and only when it is that group start. Other layouts (for
 * example HmIP-BROLL, FROLL, BBL, FBL with the transmitter on channel 3, whose
 * virtual receiver follows wall button moves) and unknown channel types give
 * undefined: the virtual channel is used, with no guess.
 */
export function transmitterAddress(address, channels) {
    const m = /^(.*):(\d+)$/.exec(address);
    if (!m || channels === undefined)
        return undefined;
    const device = m[1];
    const n = Number(m[2]);
    let found;
    for (const c of channels) {
        const cm = /^(.*):(\d+)$/.exec(c.address);
        if (!cm || cm[1] !== device || !TRANSMITTER_TYPES.includes(c.type))
            continue;
        const idx = Number(cm[2]);
        if (idx < n && (found === undefined || idx > found))
            found = idx;
    }
    const start = n - ((n - 1) % GROUP_SIZE);
    return found !== undefined && found === start ? `${device}:${found}` : undefined;
}
const STATE_STOPPED = 2;
const STATE_INCREASING = 1;
const STATE_DECREASING = 0;
/** No LEVEL change and no explicit stop within this window: treat as stopped. */
const SETTLE_MS = 5000;
/** Safety net while the CCU itself says "moving" (WORKING / ACTIVITY_STATE). */
const FAILSAFE_MS = 120000;
/** After a HomeKit write, a "stable" report from the transmitter this soon is taken as stale. */
const STALE_STABLE_MS = 5000;
/**
 * Window covering with live movement reporting.
 *
 * - Classic BLIND: WORKING (bool) and DIRECTION (1 up, 2 down) mark movement.
 * - HmIP (BLIND_/SHUTTER_VIRTUAL_RECEIVER): ACTIVITY_STATE (1 up, 2 down,
 *   3 stable); HmIP has no WORKING datapoint.
 * - Every intermediate LEVEL is pushed as CurrentPosition; the direction of
 *   successive LEVELs and of target vs current right after a command also
 *   drive PositionState.
 * - TargetPosition stays the commanded target until the move is finished
 *   (target reached, CCU reports stable, or the level stops changing); a
 *   move stopped midway then sets target = current. Moves started outside
 *   HomeKit (wall button) have no known target, so target follows current.
 * - With the imported setting `useSlats` the service also gets slat tilt
 *   (CurrentHorizontalTiltAngle / TargetHorizontalTiltAngle <-> LEVEL_2),
 *   shared with the slat blind type.
 * - HmIP virtual receivers (BLIND_/SHUTTER_VIRTUAL_RECEIVER) report only
 *   moves made through themselves. A wall button or direct link moves the
 *   blind without touching them, so CurrentPosition and PositionState come
 *   from the transmitter (status) channel of the group instead: LEVEL,
 *   ACTIVITY_STATE and PROCESS (0 = stable) plus LEVEL_2 for the slats.
 *   This applies to wired actuator layouts only (transmitter first of four).
 *   TargetPosition writes still go to the configured virtual channel. The
 *   plugin never writes a correction. When the transmitter cannot be read, or
 *   the per-channel setting `useStatusChannel` is false, the virtual channel
 *   is used as before.
 * HomeKit 100 equals CCU LEVEL 1.0 (open); no inversion is applied.
 */
class BlindHandler extends AccessoryBase {
    channelAddress = '';
    current = 0;
    target = 0;
    commanded = false;
    moving = false;
    direction = 0;
    explicitMoving = false;
    explicitStable = false;
    timer;
    service;
    statusAddress;
    /** True once the transmitter answered: it then drives position and state. */
    statusActive = false;
    /** Until this time, a stable report whose LEVEL differs from the target is ignored (see onCommand). */
    staleStableUntil = 0;
    attach(channel) {
        this.channelAddress = channel.address;
        if (VIRTUAL_RECEIVER_TYPES.includes(channel.type) && this.accessory.context?.settings?.useStatusChannel !== false) {
            this.statusAddress = transmitterAddress(channel.address, channel.siblings);
        }
        const service = this.getOrAddService(this.Service.WindowCovering, channel.name);
        this.service = service;
        service.getCharacteristic(this.Characteristic.CurrentPosition)
            .onGet(this.wrapGet(() => this.current));
        service.getCharacteristic(this.Characteristic.TargetPosition)
            .onGet(this.wrapGet(() => this.target))
            .onSet(this.wrapSet(async (value) => {
            const pct = normalizeLevelToPercent(value) ?? 0;
            this.onCommand(pct);
            await this.ccu.setValue(this.channelAddress, 'LEVEL', percentToLevelFraction(pct));
        }));
        service.getCharacteristic(this.Characteristic.PositionState)
            .onGet(this.wrapGet(() => this.positionState()));
        // Virtual channel events count until the transmitter has answered; from
        // then on only the transmitter's events do (and the other way round).
        const sources = [{ address: this.channelAddress, status: false }];
        if (this.statusAddress !== undefined) {
            sources.push({ address: this.statusAddress, status: true });
        }
        for (const { address, status } of sources) {
            const live = () => this.statusActive === status;
            this.registerListener(address, 'LEVEL', (raw) => {
                const pct = normalizeLevelToPercent(raw);
                if (pct !== undefined && live()) {
                    this.onLevel(pct);
                }
            });
            // HmIP: 0 unknown, 1 up, 2 down, 3 stable.
            this.registerListener(address, 'ACTIVITY_STATE', (raw) => {
                if (!live())
                    return;
                if (status && Number(raw) === 3 && this.isStaleStable())
                    return;
                this.onActivityState(Number(raw));
            });
            if (status) {
                // Transmitter only: 0 stable, anything else means the process is running.
                this.registerListener(address, 'PROCESS', (raw) => {
                    if (!live())
                        return;
                    if (Number(raw) === 0) {
                        if (this.isStaleStable())
                            return;
                        this.explicitStable = true;
                        this.finish();
                    }
                    else {
                        this.onExplicitMoving(0);
                    }
                });
            }
        }
        this.registerListener(this.channelAddress, 'WORKING', (raw) => {
            if (raw) {
                this.onExplicitMoving(this.direction);
            }
            else {
                this.finish();
            }
        });
        // Classic: 0 none, 1 up, 2 down, 3 undefined.
        this.registerListener(this.channelAddress, 'DIRECTION', (raw) => {
            const n = Number(raw);
            if (n === 1 || n === 2) {
                this.direction = n === 1 ? 1 : -1;
                if (this.moving) {
                    this.pushState();
                }
            }
        });
        // Imported hap-homematic setting: the blind has slats, so add tilt (LEVEL_2).
        if (this.accessory.context?.settings?.useSlats === true) {
            this.attachSlatTilt(service, this.channelAddress, () => this.positionState() !== STATE_STOPPED, this.statusAddress, () => this.statusActive);
        }
        else {
            // A cached accessory may still carry tilt from when useSlats was on.
            for (const tilt of [this.Characteristic.CurrentHorizontalTiltAngle, this.Characteristic.TargetHorizontalTiltAngle]) {
                if (service.testCharacteristic(tilt)) {
                    service.removeCharacteristic(service.getCharacteristic(tilt));
                }
            }
        }
        // Pull initial position. Without this, the accessory shows 0 (closed)
        // until the next CCU push event arrives, which for blinds may be
        // hours away. Best-effort; we ignore errors so a missing-channel
        // doesn't poison startup. With a status channel the transmitter is read
        // first; if it cannot be read, warn once and use the virtual channel.
        void this.pullInitial(service);
    }
    async pullInitial(service) {
        let pct;
        if (this.statusAddress !== undefined) {
            pct = await this.readLevel(this.statusAddress);
            if (pct === undefined) {
                this.log.warn('Status channel %s is not readable; using %s for position and state.', this.statusAddress, this.channelAddress);
            }
            else {
                this.statusActive = true;
            }
        }
        pct ??= await this.readLevel(this.channelAddress);
        if (pct === undefined)
            return;
        this.current = pct;
        this.target = pct;
        service.updateCharacteristic(this.Characteristic.CurrentPosition, pct);
        service.updateCharacteristic(this.Characteristic.TargetPosition, pct);
        service.updateCharacteristic(this.Characteristic.PositionState, STATE_STOPPED);
    }
    async readLevel(address) {
        try {
            return normalizeLevelToPercent(await this.ccu.getValue(address, 'LEVEL'));
        }
        catch {
            return undefined;
        }
    }
    onActivityState(n) {
        if (n === 1) {
            this.onExplicitMoving(1);
        }
        else if (n === 2) {
            this.onExplicitMoving(-1);
        }
        else if (n === 3) {
            this.explicitStable = true;
            this.finish();
        }
    }
    dispose() {
        this.clearTimer();
        super.dispose();
    }
    onCommand(pct) {
        this.target = pct;
        this.commanded = true;
        this.explicitStable = false;
        if (pct === this.current) {
            this.finish();
            return;
        }
        this.moving = true;
        this.direction = pct > this.current ? 1 : -1;
        // The transmitter may still report the previous "stable" just after the
        // write, before the motor starts. Ignore that until a moving report or the guard time.
        this.staleStableUntil = this.statusActive ? Date.now() + STALE_STABLE_MS : 0;
        this.pushState();
        this.arm(SETTLE_MS);
    }
    onLevel(pct) {
        const previous = this.current;
        this.current = pct;
        this.service?.updateCharacteristic(this.Characteristic.CurrentPosition, pct);
        if (pct !== previous) {
            this.direction = pct > previous ? 1 : -1;
            // A LEVEL arriving after the CCU said "stable" is the final value.
            if (!this.explicitStable) {
                this.moving = true;
            }
        }
        if (this.commanded && pct === this.target) {
            this.finish();
            return;
        }
        if (!this.commanded) {
            this.target = pct;
            this.service?.updateCharacteristic(this.Characteristic.TargetPosition, pct);
        }
        if (this.moving) {
            this.arm(this.explicitMoving ? FAILSAFE_MS : SETTLE_MS);
        }
        this.pushState();
    }
    isStaleStable() {
        return this.commanded && Date.now() < this.staleStableUntil && this.current !== this.target;
    }
    onExplicitMoving(direction) {
        this.staleStableUntil = 0;
        this.explicitMoving = true;
        this.explicitStable = false;
        this.moving = true;
        if (direction !== 0) {
            this.direction = direction;
        }
        else if (this.commanded && this.target !== this.current) {
            this.direction = this.target > this.current ? 1 : -1;
        }
        this.arm(FAILSAFE_MS);
        this.pushState();
    }
    /** Move is over: report STOPPED and settle TargetPosition on where it ended. */
    finish() {
        this.staleStableUntil = 0;
        this.clearTimer();
        this.moving = false;
        this.explicitMoving = false;
        this.commanded = false;
        this.direction = 0;
        this.target = this.current;
        this.service?.updateCharacteristic(this.Characteristic.TargetPosition, this.current);
        this.pushState();
    }
    arm(ms) {
        this.clearTimer();
        this.timer = setTimeout(() => this.finish(), ms);
        this.timer.unref?.();
    }
    clearTimer() {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
    pushState() {
        this.service?.updateCharacteristic(this.Characteristic.PositionState, this.positionState());
    }
    positionState() {
        if (!this.moving || this.direction === 0) {
            return STATE_STOPPED;
        }
        return this.direction > 0 ? STATE_INCREASING : STATE_DECREASING;
    }
}
export const blindService = {
    key: 'BlindAccessory',
    description: 'Window covering / blind / shutter',
    channelTypes: BLIND_CHANNEL_TYPES,
    priority: 10,
    build: (ctx) => new BlindHandler(ctx),
};
//# sourceMappingURL=BlindAccessory.js.map
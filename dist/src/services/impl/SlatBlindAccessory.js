import { AccessoryBase } from '../AccessoryBase.js';
import { normalizeLevelToPercent, percentToLevelFraction } from '../../util/sanitize.js';
/**
 * Window covering with adjustable slat angle (venetian blind / HmIP-BBL).
 * Adds CurrentHorizontalTiltAngle / TargetHorizontalTiltAngle to the
 * standard WindowCovering service. Slat angle lives in the CCU `LEVEL_2`
 * datapoint (0..1 fraction; 0 = horizontal/open, 1 = fully tilted shut).
 */
const SLAT_BLIND_CHANNEL_TYPES = [
    'BLIND_VIRTUAL_RECEIVER',
    'BLIND_TRANSMITTER',
];
const STATE_STOPPED = 2;
const STATE_INCREASING = 1;
const STATE_DECREASING = 0;
class SlatBlindHandler extends AccessoryBase {
    channelAddress = '';
    current = 0;
    target = 0;
    attach(channel) {
        this.channelAddress = channel.address;
        const service = this.getOrAddService(this.Service.WindowCovering, channel.name);
        service.getCharacteristic(this.Characteristic.CurrentPosition)
            .onGet(this.wrapGet(() => this.current));
        service.getCharacteristic(this.Characteristic.TargetPosition)
            .onGet(this.wrapGet(() => this.target))
            .onSet(this.wrapSet(async (value) => {
            const pct = normalizeLevelToPercent(value) ?? 0;
            this.target = pct;
            await this.ccu.setValue(this.channelAddress, 'LEVEL', percentToLevelFraction(pct));
        }));
        service.getCharacteristic(this.Characteristic.PositionState)
            .onGet(this.wrapGet(() => this.derivePositionState()));
        this.attachSlatTilt(service, this.channelAddress, () => this.derivePositionState() !== STATE_STOPPED);
        this.registerListener(this.channelAddress, 'LEVEL', (raw) => {
            const pct = normalizeLevelToPercent(raw);
            if (pct === undefined)
                return;
            this.current = pct;
            this.target = pct;
            service.updateCharacteristic(this.Characteristic.CurrentPosition, pct);
            service.updateCharacteristic(this.Characteristic.TargetPosition, pct);
            service.updateCharacteristic(this.Characteristic.PositionState, this.derivePositionState());
        });
        this.registerListener(this.channelAddress, 'WORKING', (raw) => {
            const moving = Boolean(raw);
            service.updateCharacteristic(this.Characteristic.PositionState, moving ? this.derivePositionState() : STATE_STOPPED);
        });
        // Best-effort initial pulls, same apply path as the LEVEL
        // listener above; tested via fireEvent there. LEVEL_2 is in attachSlatTilt.
        /* v8 ignore start */
        this.ccu.getValue(this.channelAddress, 'LEVEL').then((raw) => {
            const pct = normalizeLevelToPercent(raw);
            if (pct === undefined)
                return;
            this.current = pct;
            this.target = pct;
            service.updateCharacteristic(this.Characteristic.CurrentPosition, pct);
            service.updateCharacteristic(this.Characteristic.TargetPosition, pct);
            service.updateCharacteristic(this.Characteristic.PositionState, STATE_STOPPED);
        }).catch(() => undefined);
        /* v8 ignore stop */
    }
    derivePositionState() {
        if (this.target > this.current) {
            return STATE_INCREASING;
        }
        if (this.target < this.current) {
            return STATE_DECREASING;
        }
        return STATE_STOPPED;
    }
}
export const slatBlindService = {
    key: 'SlatBlindAccessory',
    description: 'Window covering with slat angle (HmIP-BBL)',
    channelTypes: SLAT_BLIND_CHANNEL_TYPES,
    // Lower priority than plain BlindAccessory — opt-in.
    priority: 50,
    build: (ctx) => new SlatBlindHandler(ctx),
};
//# sourceMappingURL=SlatBlindAccessory.js.map
import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';
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

class SlatBlindHandler extends AccessoryBase implements ChannelService {
  private channelAddress = '';
  private current = 0;
  private target = 0;

  attach(channel: CcuChannel): void {
    this.channelAddress = channel.address;
    const service = this.getOrAddService(this.Service.WindowCovering, channel.name);

    service.getCharacteristic(this.Characteristic.CurrentPosition)
      .onGet(this.wrapGet<number>(() => this.current));

    service.getCharacteristic(this.Characteristic.TargetPosition)
      .onGet(this.wrapGet<number>(() => this.target))
      .onSet(this.wrapSet<number>(async (value) => {
        const pct = normalizeLevelToPercent(value) ?? 0;
        this.target = pct;
        await this.ccu.setValue(this.channelAddress, 'LEVEL', percentToLevelFraction(pct));
      }));

    service.getCharacteristic(this.Characteristic.PositionState)
      .onGet(this.wrapGet<number>(() => this.derivePositionState()));

    this.attachSlatTilt(service, this.channelAddress);

    this.registerListener(this.channelAddress, 'LEVEL', (raw) => {
      const pct = normalizeLevelToPercent(raw);
      if (pct === undefined) return;
      this.current = pct;
      this.target = pct;
      service.updateCharacteristic(this.Characteristic.CurrentPosition, pct);
      service.updateCharacteristic(this.Characteristic.TargetPosition, pct);
      service.updateCharacteristic(this.Characteristic.PositionState, this.derivePositionState());
    });

    this.registerListener(this.channelAddress, 'WORKING', (raw) => {
      const moving = Boolean(raw);
      service.updateCharacteristic(
        this.Characteristic.PositionState,
        moving ? this.derivePositionState() : STATE_STOPPED,
      );
    });

    // Best-effort initial pulls, same apply path as the LEVEL
    // listener above; tested via fireEvent there. LEVEL_2 is in attachSlatTilt.
    /* v8 ignore start */
    this.ccu.getValue(this.channelAddress, 'LEVEL').then((raw) => {
      const pct = normalizeLevelToPercent(raw);
      if (pct === undefined) return;
      this.current = pct;
      this.target = pct;
      service.updateCharacteristic(this.Characteristic.CurrentPosition, pct);
      service.updateCharacteristic(this.Characteristic.TargetPosition, pct);
      service.updateCharacteristic(this.Characteristic.PositionState, STATE_STOPPED);
    }).catch(() => undefined);
    /* v8 ignore stop */
  }

  private derivePositionState(): number {
    if (this.target > this.current) {
      return STATE_INCREASING;
    }
    if (this.target < this.current) {
      return STATE_DECREASING;
    }
    return STATE_STOPPED;
  }
}

export const slatBlindService: ServiceDefinition = {
  key: 'SlatBlindAccessory',
  description: 'Window covering with slat angle (HmIP-BBL)',
  channelTypes: SLAT_BLIND_CHANNEL_TYPES,
  // Lower priority than plain BlindAccessory — opt-in.
  priority: 50,
  build: (ctx: ServiceContext) => new SlatBlindHandler(ctx),
};

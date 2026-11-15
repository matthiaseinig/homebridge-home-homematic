import type { Service } from 'homebridge';
import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';
import { normalizeLevelToPercent, percentToLevelFraction } from '../../util/sanitize.js';

const BLIND_CHANNEL_TYPES = [
  'BLIND',
  'BLIND_VIRTUAL_RECEIVER',
  'SHUTTER_VIRTUAL_RECEIVER',
];

/** HmIP virtual receivers whose group of four starts with the transmitter (status) channel. */
const VIRTUAL_RECEIVER_TYPES = ['BLIND_VIRTUAL_RECEIVER', 'SHUTTER_VIRTUAL_RECEIVER'];
const GROUP_SIZE = 4;

/**
 * Status (transmitter) channel of an HmIP virtual receiver: the first channel
 * of its group of four, n - ((n - 1) % 4). Undefined when the address has no
 * channel index, or the channel already is the first of its group.
 */
export function transmitterAddress(address: string): string | undefined {
  const m = /^(.*):(\d+)$/.exec(address);
  if (!m) return undefined;
  const n = Number(m[2]);
  const start = n - ((n - 1) % GROUP_SIZE);
  return n >= 2 && start < n ? `${m[1]}:${start}` : undefined;
}

const STATE_STOPPED = 2;
const STATE_INCREASING = 1;
const STATE_DECREASING = 0;

/** No LEVEL change and no explicit stop within this window: treat as stopped. */
const SETTLE_MS = 5000;
/** Safety net while the CCU itself says "moving" (WORKING / ACTIVITY_STATE). */
const FAILSAFE_MS = 120000;

type Direction = -1 | 0 | 1;

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
 *   TargetPosition writes still go to the configured virtual channel. The
 *   plugin never writes a correction. When the transmitter cannot be read, or
 *   the per-channel setting `useStatusChannel` is false, the virtual channel
 *   is used as before.
 * HomeKit 100 equals CCU LEVEL 1.0 (open); no inversion is applied.
 */
class BlindHandler extends AccessoryBase implements ChannelService {
  private channelAddress = '';
  private current = 0;
  private target = 0;
  private commanded = false;
  private moving = false;
  private direction: Direction = 0;
  private explicitMoving = false;
  private explicitStable = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private service?: Service;
  private statusAddress: string | undefined;
  /** True once the transmitter answered: it then drives position and state. */
  private statusActive = false;

  attach(channel: CcuChannel): void {
    this.channelAddress = channel.address;
    if (VIRTUAL_RECEIVER_TYPES.includes(channel.type) && this.accessory.context?.settings?.useStatusChannel !== false) {
      this.statusAddress = transmitterAddress(channel.address);
    }
    const service = this.getOrAddService(this.Service.WindowCovering, channel.name);
    this.service = service;

    service.getCharacteristic(this.Characteristic.CurrentPosition)
      .onGet(this.wrapGet<number>(() => this.current));

    service.getCharacteristic(this.Characteristic.TargetPosition)
      .onGet(this.wrapGet<number>(() => this.target))
      .onSet(this.wrapSet<number>(async (value) => {
        const pct = normalizeLevelToPercent(value) ?? 0;
        this.onCommand(pct);
        await this.ccu.setValue(this.channelAddress, 'LEVEL', percentToLevelFraction(pct));
      }));

    service.getCharacteristic(this.Characteristic.PositionState)
      .onGet(this.wrapGet<number>(() => this.positionState()));

    // Virtual channel events count until the transmitter has answered; from
    // then on only the transmitter's events do (and the other way round).
    const sources = [{ address: this.channelAddress, status: false }];
    if (this.statusAddress !== undefined) {
      sources.push({ address: this.statusAddress, status: true });
    }
    for (const { address, status } of sources) {
      const live = (): boolean => this.statusActive === status;

      this.registerListener(address, 'LEVEL', (raw) => {
        const pct = normalizeLevelToPercent(raw);
        if (pct !== undefined && live()) {
          this.onLevel(pct);
        }
      });

      // HmIP: 0 unknown, 1 up, 2 down, 3 stable.
      this.registerListener(address, 'ACTIVITY_STATE', (raw) => {
        if (live()) this.onActivityState(Number(raw));
      });

      if (status) {
        // Transmitter only: 0 stable, anything else means the process is running.
        this.registerListener(address, 'PROCESS', (raw) => {
          if (!live()) return;
          if (Number(raw) === 0) {
            this.explicitStable = true;
            this.finish();
          } else {
            this.onExplicitMoving(0);
          }
        });
      }
    }

    this.registerListener(this.channelAddress, 'WORKING', (raw) => {
      if (raw) {
        this.onExplicitMoving(this.direction);
      } else {
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
      this.attachSlatTilt(service, this.channelAddress, () => this.positionState() !== STATE_STOPPED, this.statusAddress);
    } else {
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

  private async pullInitial(service: Service): Promise<void> {
    let pct: number | undefined;
    if (this.statusAddress !== undefined) {
      pct = await this.readLevel(this.statusAddress);
      if (pct === undefined) {
        this.log.warn(
          'Status channel %s is not readable; using %s for position and state.',
          this.statusAddress, this.channelAddress,
        );
      } else {
        this.statusActive = true;
      }
    }
    pct ??= await this.readLevel(this.channelAddress);
    if (pct === undefined) return;
    this.current = pct;
    this.target = pct;
    service.updateCharacteristic(this.Characteristic.CurrentPosition, pct);
    service.updateCharacteristic(this.Characteristic.TargetPosition, pct);
    service.updateCharacteristic(this.Characteristic.PositionState, STATE_STOPPED);
  }

  private async readLevel(address: string): Promise<number | undefined> {
    try {
      return normalizeLevelToPercent(await this.ccu.getValue(address, 'LEVEL'));
    } catch {
      return undefined;
    }
  }

  private onActivityState(n: number): void {
    if (n === 1) {
      this.onExplicitMoving(1);
    } else if (n === 2) {
      this.onExplicitMoving(-1);
    } else if (n === 3) {
      this.explicitStable = true;
      this.finish();
    }
  }

  override dispose(): void {
    this.clearTimer();
    super.dispose();
  }

  private onCommand(pct: number): void {
    this.target = pct;
    this.commanded = true;
    this.explicitStable = false;
    if (pct === this.current) {
      this.finish();
      return;
    }
    this.moving = true;
    this.direction = pct > this.current ? 1 : -1;
    this.pushState();
    this.arm(SETTLE_MS);
  }

  private onLevel(pct: number): void {
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

  private onExplicitMoving(direction: Direction): void {
    this.explicitMoving = true;
    this.explicitStable = false;
    this.moving = true;
    if (direction !== 0) {
      this.direction = direction;
    } else if (this.commanded && this.target !== this.current) {
      this.direction = this.target > this.current ? 1 : -1;
    }
    this.arm(FAILSAFE_MS);
    this.pushState();
  }

  /** Move is over: report STOPPED and settle TargetPosition on where it ended. */
  private finish(): void {
    this.clearTimer();
    this.moving = false;
    this.explicitMoving = false;
    this.commanded = false;
    this.direction = 0;
    this.target = this.current;
    this.service?.updateCharacteristic(this.Characteristic.TargetPosition, this.current);
    this.pushState();
  }

  private arm(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.finish(), ms);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private pushState(): void {
    this.service?.updateCharacteristic(this.Characteristic.PositionState, this.positionState());
  }

  private positionState(): number {
    if (!this.moving || this.direction === 0) {
      return STATE_STOPPED;
    }
    return this.direction > 0 ? STATE_INCREASING : STATE_DECREASING;
  }
}

export const blindService: ServiceDefinition = {
  key: 'BlindAccessory',
  description: 'Window covering / blind / shutter',
  channelTypes: BLIND_CHANNEL_TYPES,
  priority: 10,
  build: (ctx: ServiceContext) => new BlindHandler(ctx),
};

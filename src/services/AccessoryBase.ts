/**
 * Base class shared by per-accessory handlers. Provides:
 *   - access to platform-level objects (Service / Characteristic / api / ccu)
 *   - getOrAdd helpers for HAP services
 *   - registerListener() that auto-cleans on dispose()
 *   - safe wrappers for onGet / onSet that route errors to log + HAP fault
 *
 * Services subclass this and implement attach().
 */

import type { Characteristic, CharacteristicValue, Service, WithUUID } from 'homebridge';
import type { CcuClient } from '../ccu/CcuClient.js';
import type { PrefixedLogger } from '../util/logger.js';
import { toFiniteNumber } from '../util/sanitize.js';
import { SlatWriter } from './slatWriter.js';
import type { AccessoryHandle, ServiceContext } from './types.js';

const HK_TILT_MIN = -90;
const HK_TILT_MAX = 90;
const HK_TILT_RANGE = HK_TILT_MAX - HK_TILT_MIN;

export type DatapointListener = (value: unknown) => void;

export abstract class AccessoryBase {
  protected readonly accessory: AccessoryHandle;
  protected readonly ccu: CcuClient;
  protected readonly log: PrefixedLogger;
  protected readonly Service: typeof Service;
  protected readonly Characteristic: typeof Characteristic;

  private readonly disposers: Array<() => void> = [];
  private slatWriter: SlatWriter | undefined;

  constructor(ctx: ServiceContext) {
    this.accessory = ctx.accessory;
    this.ccu = ctx.ccu;
    this.log = ctx.log;
    this.Service = ctx.Service;
    this.Characteristic = ctx.Characteristic;
  }

  /**
   * @param legacy Subtype to use when the accessory reuses a hap-homematic
   *   identity (`context.legacyLayout`). hap-homematic created most services
   *   with the service UUID as subtype; pass `null` for services it created
   *   without one (e.g. Thermostat), or a string for its explicit subtypes.
   *   Ignored for accessories with their own identity.
   */
  protected getOrAddService<T extends WithUUID<typeof Service>>(
    svc: T,
    name?: string,
    requestedSubtype?: string,
    legacy?: string | null,
  ): Service {
    const subtype = this.resolveSubtype(svc, requestedSubtype, legacy);
    const existing = subtype === undefined
      ? this.accessory.getService(svc)
      : this.accessory.getServiceById(svc, subtype);
    if (existing) {
      if (name !== undefined) {
        existing.setCharacteristic(this.Characteristic.Name, name);
      }
      return existing;
    }
    // hap-nodejs Service constructors take (displayName, subtype). The
    // overloaded addService(svc) signature cannot express that mix, so
    // we instantiate ourselves when we need a non-default name/subtype.
    const instance = subtype === undefined
      ? new (svc as unknown as new (displayName: string) => Service)(name ?? this.accessory.displayName)
      : new (svc as unknown as new (displayName: string, subtype: string) => Service)(
        name ?? this.accessory.displayName,
        subtype,
      );
    return this.accessory.addService(instance);
  }

  protected isLegacyLayout(): boolean {
    return this.accessory.context?.legacyLayout === true;
  }

  private resolveSubtype(
    svc: WithUUID<typeof Service>,
    requested: string | undefined,
    legacy: string | null | undefined,
  ): string | undefined {
    if (!this.isLegacyLayout()) {
      return requested;
    }
    if (legacy === null) {
      return undefined;
    }
    return legacy ?? (svc as unknown as { UUID: string }).UUID;
  }

  /**
   * Attach a listener for a CCU datapoint on this accessory. Returns a
   * disposer that is also tracked for automatic cleanup in dispose().
   */
  protected registerListener(address: string, datapoint: string, listener: DatapointListener): () => void {
    const key = `${address}.${datapoint}`;
    const off = this.ccu.registerListener(key, listener);
    this.disposers.push(off);
    return off;
  }

  /** Tracked async setter that maps thrown errors to a HAP-friendly fault. */
  protected wrapSet<T extends CharacteristicValue>(handler: (v: T) => Promise<void> | void) {
    return async (value: CharacteristicValue) => {
      try {
        await handler(value as T);
      } catch (err) {
        this.log.warn('setValue failed: %s', (err as Error).message);
        throw err;
      }
    };
  }

  protected wrapGet<T extends CharacteristicValue>(handler: () => Promise<T> | T) {
    return async (): Promise<CharacteristicValue> => {
      try {
        const v = await handler();
        return v as CharacteristicValue;
      } catch (err) {
        this.log.debug('getValue cache miss: %s', (err as Error).message);
        throw err;
      }
    };
  }

  /**
   * Attach a HAP BatteryService that mirrors the device-level LOW_BAT
   * datapoint (and OPERATING_VOLTAGE / BATTERY_STATE if exposed) into
   * HomeKit's StatusLowBattery + BatteryLevel characteristics.
   *
   * Battery datapoints live on the **device** channel (`:0`), not on
   * any feature channel, so we strip the channel suffix from the
   * address we were given.
   *
   * Best-effort: if the device doesn't actually expose a battery
   * datapoint, the listeners are dormant and the service shows the
   * default "battery OK" state. Mains-powered devices simply shouldn't
   * call this.
   */
  protected attachBattery(featureChannelAddress: string): void {
    const colon = featureChannelAddress.lastIndexOf(':');
    const deviceAddress = colon === -1
      ? `${featureChannelAddress}:0`
      : `${featureChannelAddress.slice(0, colon)}:0`;
    const service = this.getOrAddService(this.Service.Battery, undefined, 'battery');
    let lowBat = false;
    let level = 100;

    service.getCharacteristic(this.Characteristic.StatusLowBattery)
      .onGet(this.wrapGet<number>(() => lowBat
        ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL));
    service.getCharacteristic(this.Characteristic.BatteryLevel)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(this.wrapGet<number>(() => level));
    service.getCharacteristic(this.Characteristic.ChargingState)
      .onGet(() => this.Characteristic.ChargingState.NOT_CHARGEABLE);

    const applyLow = (raw: unknown): void => {
      lowBat = raw === true || raw === 1 || raw === '1' || raw === 'true';
      service.updateCharacteristic(
        this.Characteristic.StatusLowBattery,
        lowBat
          ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );
    };
    const applyVoltage = (raw: unknown): void => {
      // HmIP devices nominally report 0..4 V; map 2.4..3.2 → 0..100 %.
      // Anything outside that range gets clamped. This is a heuristic;
      // CCU does not surface a real % anywhere.
      const v = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
      if (!Number.isFinite(v)) return;
      const pct = Math.min(100, Math.max(0, Math.round(((v - 2.4) / (3.2 - 2.4)) * 100)));
      level = pct;
      service.updateCharacteristic(this.Characteristic.BatteryLevel, pct);
    };

    this.registerListener(deviceAddress, 'LOW_BAT', applyLow);
    this.registerListener(deviceAddress, 'LOWBAT', applyLow); // legacy spelling
    this.registerListener(deviceAddress, 'OPERATING_VOLTAGE', applyVoltage);

    // Best-effort initial pulls so HomeKit doesn't sit on default values.
    this.ccu.getValue(deviceAddress, 'LOW_BAT').then(applyLow).catch(() => undefined);
    this.ccu.getValue(deviceAddress, 'OPERATING_VOLTAGE').then(applyVoltage).catch(() => undefined);
  }

  /**
   * Add slat tilt to a WindowCovering service: Current/TargetHorizontalTiltAngle
   * (-90..90) mapped to the CCU `LEVEL_2` datapoint (0..1 fraction). Tilt
   * writes go through a SlatWriter (debounced; mode from the plugin setting
   * `slatWriteMode`) because HmIP actuators ignore a lone LEVEL_2. Positions
   * are not touched: the handler writes LEVEL itself. Shared by the slat blind
   * type and by the normal blind type when its imported `useSlats` setting is on.
   */
  protected attachSlatTilt(
    service: Service,
    channelAddress: string,
    isMoving: () => boolean,
    statusAddress?: string,
    statusActive: () => boolean = () => false,
  ): void {
    let currentTilt = 0;
    let targetTilt = 0;
    this.slatWriter = new SlatWriter({
      ccu: this.ccu,
      address: channelAddress,
      mode: this.ccu.slatWriteMode,
      log: this.log,
      isMoving,
      onFailure: () => {
        targetTilt = currentTilt;
        service.updateCharacteristic(this.Characteristic.TargetHorizontalTiltAngle, currentTilt);
      },
    });
    const writer = this.slatWriter;

    service.getCharacteristic(this.Characteristic.CurrentHorizontalTiltAngle)
      .setProps({ minValue: HK_TILT_MIN, maxValue: HK_TILT_MAX, minStep: 1 })
      .onGet(this.wrapGet<number>(() => currentTilt));

    service.getCharacteristic(this.Characteristic.TargetHorizontalTiltAngle)
      .setProps({ minValue: HK_TILT_MIN, maxValue: HK_TILT_MAX, minStep: 1 })
      .onGet(this.wrapGet<number>(() => targetTilt))
      .onSet(this.wrapSet<number>(async (value) => {
        targetTilt = value;
        await writer.setTilt((value - HK_TILT_MIN) / HK_TILT_RANGE);
      }));

    // Display only: HmIP reports LEVEL_2 up to 1.01, clamped here and never written back.
    const apply = (raw: unknown): void => {
      const f = toFiniteNumber(raw);
      if (f === undefined) return;
      currentTilt = Math.round(HK_TILT_MIN + Math.max(0, Math.min(1, f)) * HK_TILT_RANGE);
      targetTilt = currentTilt;
      service.updateCharacteristic(this.Characteristic.CurrentHorizontalTiltAngle, currentTilt);
      service.updateCharacteristic(this.Characteristic.TargetHorizontalTiltAngle, targetTilt);
    };

    // `statusAddress` is the transmitter of an HmIP group: it also sees tilt
    // changes made by a wall button. Writes still go to `channelAddress`.
    // One source at a time, like position: the transmitter once it has answered.
    this.registerListener(channelAddress, 'LEVEL_2', (raw) => {
      if (!statusActive()) apply(raw);
    });
    if (statusAddress !== undefined) {
      this.registerListener(statusAddress, 'LEVEL_2', (raw) => {
        if (statusActive()) apply(raw);
      });
      this.ccu.getValue(statusAddress, 'LEVEL_2')
        .then((raw) => (toFiniteNumber(raw) === undefined ? this.ccu.getValue(channelAddress, 'LEVEL_2') : raw))
        .catch(() => this.ccu.getValue(channelAddress, 'LEVEL_2'))
        .then(apply).catch(() => undefined);
    } else {
      this.ccu.getValue(channelAddress, 'LEVEL_2').then(apply).catch(() => undefined);
    }
  }

  dispose(): void {
    this.slatWriter?.dispose();
    while (this.disposers.length > 0) {
      const fn = this.disposers.pop();
      try {
        fn?.();
      } catch (err) {
        this.log.debug('dispose listener error: %s', (err as Error).message);
      }
    }
  }
}

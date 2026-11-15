/**
 * Base class shared by per-accessory handlers. Provides:
 *   - access to platform-level objects (Service / Characteristic / api / ccu)
 *   - getOrAdd helpers for HAP services
 *   - registerListener() that auto-cleans on dispose()
 *   - safe wrappers for onGet / onSet that route errors to log + HAP fault
 *
 * Services subclass this and implement attach().
 */
import { toFiniteNumber } from '../util/sanitize.js';
import { SlatWriter } from './slatWriter.js';
const HK_TILT_MIN = -90;
const HK_TILT_MAX = 90;
const HK_TILT_RANGE = HK_TILT_MAX - HK_TILT_MIN;
export class AccessoryBase {
    accessory;
    ccu;
    log;
    Service;
    Characteristic;
    disposers = [];
    slatWriter;
    constructor(ctx) {
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
    getOrAddService(svc, name, requestedSubtype, legacy) {
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
            ? new svc(name ?? this.accessory.displayName)
            : new svc(name ?? this.accessory.displayName, subtype);
        return this.accessory.addService(instance);
    }
    isLegacyLayout() {
        return this.accessory.context?.legacyLayout === true;
    }
    resolveSubtype(svc, requested, legacy) {
        if (!this.isLegacyLayout()) {
            return requested;
        }
        if (legacy === null) {
            return undefined;
        }
        return legacy ?? svc.UUID;
    }
    /**
     * Attach a listener for a CCU datapoint on this accessory. Returns a
     * disposer that is also tracked for automatic cleanup in dispose().
     */
    registerListener(address, datapoint, listener) {
        const key = `${address}.${datapoint}`;
        const off = this.ccu.registerListener(key, listener);
        this.disposers.push(off);
        return off;
    }
    /** Tracked async setter that maps thrown errors to a HAP-friendly fault. */
    wrapSet(handler) {
        return async (value) => {
            try {
                await handler(value);
            }
            catch (err) {
                this.log.warn('setValue failed: %s', err.message);
                throw err;
            }
        };
    }
    wrapGet(handler) {
        return async () => {
            try {
                const v = await handler();
                return v;
            }
            catch (err) {
                this.log.debug('getValue cache miss: %s', err.message);
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
    attachBattery(featureChannelAddress) {
        const colon = featureChannelAddress.lastIndexOf(':');
        const deviceAddress = colon === -1
            ? `${featureChannelAddress}:0`
            : `${featureChannelAddress.slice(0, colon)}:0`;
        const service = this.getOrAddService(this.Service.Battery, undefined, 'battery');
        let lowBat = false;
        let level = 100;
        service.getCharacteristic(this.Characteristic.StatusLowBattery)
            .onGet(this.wrapGet(() => lowBat
            ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL));
        service.getCharacteristic(this.Characteristic.BatteryLevel)
            .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
            .onGet(this.wrapGet(() => level));
        service.getCharacteristic(this.Characteristic.ChargingState)
            .onGet(() => this.Characteristic.ChargingState.NOT_CHARGEABLE);
        const applyLow = (raw) => {
            lowBat = raw === true || raw === 1 || raw === '1' || raw === 'true';
            service.updateCharacteristic(this.Characteristic.StatusLowBattery, lowBat
                ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
        };
        const applyVoltage = (raw) => {
            // HmIP devices nominally report 0..4 V; map 2.4..3.2 → 0..100 %.
            // Anything outside that range gets clamped. This is a heuristic;
            // CCU does not surface a real % anywhere.
            const v = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
            if (!Number.isFinite(v))
                return;
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
    attachSlatTilt(service, channelAddress, isMoving) {
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
            .onGet(this.wrapGet(() => currentTilt));
        service.getCharacteristic(this.Characteristic.TargetHorizontalTiltAngle)
            .setProps({ minValue: HK_TILT_MIN, maxValue: HK_TILT_MAX, minStep: 1 })
            .onGet(this.wrapGet(() => targetTilt))
            .onSet(this.wrapSet(async (value) => {
            targetTilt = value;
            await writer.setTilt((value - HK_TILT_MIN) / HK_TILT_RANGE);
        }));
        // Display only: HmIP reports LEVEL_2 up to 1.01, clamped here and never written back.
        const apply = (raw) => {
            const f = toFiniteNumber(raw);
            if (f === undefined)
                return;
            currentTilt = Math.round(HK_TILT_MIN + Math.max(0, Math.min(1, f)) * HK_TILT_RANGE);
            targetTilt = currentTilt;
            service.updateCharacteristic(this.Characteristic.CurrentHorizontalTiltAngle, currentTilt);
            service.updateCharacteristic(this.Characteristic.TargetHorizontalTiltAngle, targetTilt);
        };
        this.registerListener(channelAddress, 'LEVEL_2', apply);
        this.ccu.getValue(channelAddress, 'LEVEL_2').then(apply).catch(() => undefined);
    }
    dispose() {
        this.slatWriter?.dispose();
        while (this.disposers.length > 0) {
            const fn = this.disposers.pop();
            try {
                fn?.();
            }
            catch (err) {
                this.log.debug('dispose listener error: %s', err.message);
            }
        }
    }
}
//# sourceMappingURL=AccessoryBase.js.map
/**
 * The DynamicPlatformPlugin entry point. Wires CCU client + service
 * registry + Homebridge accessory cache together. Lifecycle:
 *
 *   constructor()        — validate config, build CCU client
 *   configureAccessory() — restore one accessory from disk cache
 *   didFinishLaunching   — start CCU client, then materialize accessories
 *                          for every channel/variable/program in config
 *   shutdown             — stop CCU client (event server + RPC subs)
 */
import { CcuClient } from './ccu/CcuClient.js';
import { GasMeter } from './gas/GasMeter.js';
import { gasMappingConflict, resolveGasPlacement } from './gas/placement.js';
import { findProgramServiceByKey, findServiceByKey, findVariableServiceByKey, pickVariableService, PROGRAM_SERVICE_DEFINITIONS, } from './services/registry.js';
import { PLATFORM_NAME, PLUGIN_NAME, PLUGIN_VERSION } from './settings.js';
import { MultiBridgeHost } from './multiBridge/MultiBridgeHost.js';
import { persistIdentityStore } from './multiBridge/identityStore.js';
import { ConfigError, resolveConfig } from './util/config.js';
import { PrefixedLogger } from './util/logger.js';
import { channelDisplayName, deviceChannels, findChannel, programDisplayName, variableDisplayName } from './util/mappings.js';
import { PluginStorage } from './util/storage.js';
export class HomematicPlatform {
    Service;
    Characteristic;
    api;
    log;
    storage;
    resolved;
    ccu;
    cachedAccessories = new Map();
    managed = new Map();
    /** Per-launch memo so N mapped channels cost one CCU device listing, not N. */
    devicesMemo;
    variablesMemo;
    multiBridgeHost;
    gas;
    /** Where the gas meter accessory goes; undefined: not published (no gas meter or a placement error). */
    gasPlacement;
    constructor(log, config, api) {
        this.api = api;
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        this.log = new PrefixedLogger(log, PLATFORM_NAME);
        this.storage = new PluginStorage(api);
        try {
            this.resolved = resolveConfig(config);
        }
        catch (err) {
            if (err instanceof ConfigError) {
                // Per the verified-plugin rule: log and stay idle, do not crash.
                this.log.error('Plugin not configured: %s', err.message);
                return;
            }
            throw err;
        }
        this.ccu = new CcuClient({ config: this.resolved, log: this.log.child('ccu') });
        const gasLog = this.log.child('gas');
        for (const e of this.resolved.gasErrors) {
            gasLog.error('Config: %s', e);
        }
        if (this.resolved.gas.enabled) {
            this.gas = new GasMeter({
                settings: this.resolved.gas,
                hap: api.hap,
                session: this.ccu.api,
                ccu: {
                    host: this.resolved.ccuIp,
                    username: this.resolved.ccuAuth.enabled ? this.resolved.ccuAuth.username : undefined,
                    password: this.resolved.ccuAuth.enabled ? this.resolved.ccuAuth.password : undefined,
                },
                storageRoot: this.storage.rootPath(),
                log: gasLog,
            });
            const placed = resolveGasPlacement(this.resolved.gas.bridge, this.resolved.multiBridge);
            if ('error' in placed) {
                gasLog.error('Config: %s', placed.error);
            }
            else {
                this.gasPlacement = placed.placement;
            }
        }
        if (this.resolved.multiBridge) {
            const gas = this.gas;
            const gasBridge = this.gasPlacement?.kind === 'bridge' ? this.gasPlacement.name : undefined;
            this.multiBridgeHost = new MultiBridgeHost({
                hap: api.hap,
                ccu: this.ccu,
                config: this.resolved.multiBridge,
                log: this.log.child('multi'),
                version: PLUGIN_VERSION,
                identityStore: persistIdentityStore(api.user.persistPath()),
                gas: this.resolved.gas,
                extraAccessories: gas && gasBridge !== undefined
                    ? (entry) => (entry.name === gasBridge ? [gas.createBridgedAccessory()] : [])
                    : undefined,
            });
        }
        this.api.on('didFinishLaunching', () => {
            this.didFinishLaunching().catch((err) => {
                this.log.error('Startup failed: %s', err.message);
            });
        });
        this.api.on('shutdown', () => {
            this.shutdown().catch((err) => {
                this.log.warn('Shutdown error: %s', err.message);
            });
        });
    }
    configureAccessory(accessory) {
        this.cachedAccessories.set(accessory.UUID, accessory);
        this.log.debug('Restored accessory %s', accessory.displayName);
    }
    /** Public for the homebridge-ui server to query CCU on demand. */
    getCcu() {
        return this.ccu;
    }
    // --- private -------------------------------------------------------
    async didFinishLaunching() {
        if (!this.resolved || !this.ccu) {
            return;
        }
        // The gas meter is polled through the JSON-RPC session; it starts before
        // (and independently of) the XML-RPC event subscriptions.
        const gasUuid = await this.startGas();
        if (this.multiBridgeHost) {
            // The host publishes its own HAP bridges; this block's own (child)
            // bridge carries no accessories, except the gas meter when it is
            // placed on the host. Other cached ones are left untouched.
            this.dropMovedGasAccessory(gasUuid);
            const ignored = [...this.cachedAccessories.keys()].filter((uuid) => uuid !== gasUuid).length;
            if (ignored > 0) {
                this.log.warn('Multi-bridge mode ignores %d cached accessories of this block', ignored);
            }
            await this.multiBridgeHost.start();
            return;
        }
        await this.storage.ensureRoot();
        await this.ccu.start();
        this.log.success('Connected to CCU at %s', this.resolved.ccuIp);
        // Materialize each channel/variable/program from config.
        const seen = new Set();
        if (gasUuid !== undefined) {
            seen.add(gasUuid);
        }
        for (const mapping of this.resolved.channels) {
            const conflict = gasMappingConflict(this.resolved.gas, mapping);
            if (conflict) {
                // The gas meter device address is not logged.
                this.log.warn('Gas meter mode: skipping a channel mapping (%s): %s', mapping.service, conflict);
                continue;
            }
            try {
                const uuid = this.accessoryUuid(`channel:${mapping.address}`, mapping.uuidSeed);
                seen.add(uuid);
                await this.attachChannel(uuid, mapping.address, mapping);
            }
            catch (err) {
                this.log.warn('Skipping channel %s: %s', mapping.address, err.message);
            }
        }
        for (const mapping of this.resolved.variables) {
            try {
                const uuid = this.accessoryUuid(`variable:${mapping.name}`, mapping.uuidSeed);
                seen.add(uuid);
                await this.attachVariable(uuid, mapping.name, mapping.service, mapping.settings, variableDisplayName(mapping), mapping.subtype);
            }
            catch (err) {
                this.log.warn('Skipping variable %s: %s', mapping.name, err.message);
            }
        }
        for (const mapping of this.resolved.programs) {
            try {
                const uuid = this.api.hap.uuid.generate(`program:${mapping.name}`);
                seen.add(uuid);
                await this.attachProgram(uuid, mapping.name, programDisplayName(mapping));
            }
            catch (err) {
                this.log.warn('Skipping program %s: %s', mapping.name, err.message);
            }
        }
        this.devicesMemo = undefined;
        this.variablesMemo = undefined;
        // Drop cached accessories that are no longer in config.
        const toRemove = [];
        for (const [uuid, acc] of this.cachedAccessories) {
            if (!seen.has(uuid)) {
                toRemove.push(acc);
                this.cachedAccessories.delete(uuid);
            }
        }
        if (toRemove.length > 0) {
            this.log.info('Removing %d stale accessories', toRemove.length);
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRemove);
        }
    }
    async shutdown() {
        if (this.gas) {
            try {
                await this.gas.stop();
            }
            catch (err) {
                this.log.warn('Gas meter stop failed: %s', err.message);
            }
        }
        if (this.multiBridgeHost) {
            await this.multiBridgeHost.stop();
            return;
        }
        for (const m of this.managed.values()) {
            try {
                m.handler.dispose?.();
            }
            catch (err) {
                this.log.debug('dispose error: %s', err.message);
            }
        }
        this.managed.clear();
        /* c8 ignore next 3 */
        if (this.ccu) {
            await this.ccu.stop();
        }
    }
    async attachChannel(uuid, address, mapping) {
        /* c8 ignore start — unreachable: didFinishLaunching gates on ccu */
        if (!this.ccu) {
            return;
        }
        /* c8 ignore stop */
        const def = findServiceByKey(mapping.service);
        if (!def) {
            throw new Error(`Unknown service: ${mapping.service}`);
        }
        const channel = await this.fetchChannel(address, mapping.name);
        const conflict = gasMappingConflict(this.resolved?.gas, mapping, channel.type);
        if (conflict) {
            throw new Error(`gas meter mode: ${conflict}`);
        }
        // mapping.name is the user-customised HomeKit display name (set in the
        // GUI or imported from hap-homematic); see channelDisplayName.
        const displayName = channelDisplayName(mapping, channel);
        const accessory = this.getOrCreateAccessory(uuid, displayName, {
            kind: 'channel',
            id: address,
            service: def.key,
            subtype: mapping.subtype,
            settings: mapping.settings,
            name: displayName,
            legacyLayout: this.usesLegacyIdentity(mapping.uuidSeed),
        });
        this.setSerial(accessory, address);
        const ctx = {
            accessory,
            ccu: this.ccu,
            log: this.log.child(`svc:${def.key}:${channel.address}`),
            Service: this.Service,
            Characteristic: this.Characteristic,
        };
        const handler = def.build(ctx);
        // Services name their HAP services after the channel. Use the HomeKit
        // name (as hap-homematic did), not the raw CCU channel name, which often
        // contains characters HomeKit rejects (`OG:Bad:Rollo`, `HmIP-WTH-2 0001…:1`).
        handler.attach({ ...channel, name: displayName, siblings: await this.siblingsOf(address) });
        this.managed.set(uuid, { accessory, handler });
    }
    async attachVariable(uuid, name, serviceKey, settings, displayName, subtype) {
        /* c8 ignore start — unreachable: didFinishLaunching gates on ccu */
        if (!this.ccu) {
            return;
        }
        /* c8 ignore stop */
        this.variablesMemo ??= this.ccu.listVariables();
        const variables = await this.variablesMemo;
        const variable = variables.find((v) => v.name === name);
        if (!variable) {
            throw new Error(`Variable not found on CCU: ${name}`);
        }
        const explicit = serviceKey ? findVariableServiceByKey(serviceKey) : undefined;
        const def = explicit ?? pickVariableService(variable.valuetype);
        const finalName = displayName && displayName.length > 0 ? displayName : name;
        const seed = this.resolved?.variables.find((m) => m.name === name)?.uuidSeed;
        const accessory = this.getOrCreateAccessory(uuid, finalName, {
            kind: 'variable',
            id: name,
            service: def.key,
            subtype,
            settings,
            name: finalName,
            legacyLayout: this.usesLegacyIdentity(seed),
        });
        this.setSerial(accessory, `var:${variable.id}`);
        const ctx = {
            accessory,
            ccu: this.ccu,
            log: this.log.child(`svc:${def.key}:${name}`),
            Service: this.Service,
            Characteristic: this.Characteristic,
        };
        const handler = def.build(ctx);
        handler.attach(variable);
        this.managed.set(uuid, { accessory, handler });
    }
    async attachProgram(uuid, name, displayName) {
        /* c8 ignore start — unreachable: didFinishLaunching gates on ccu */
        if (!this.ccu) {
            return;
        }
        /* c8 ignore stop */
        const def = findProgramServiceByKey('ProgramAccessory') ?? PROGRAM_SERVICE_DEFINITIONS[0];
        const finalName = displayName && displayName.length > 0 ? displayName : name;
        const accessory = this.getOrCreateAccessory(uuid, finalName, {
            kind: 'program',
            id: name,
            service: def.key,
            name: finalName,
        });
        this.setSerial(accessory, `prog:${name}`);
        const ctx = {
            accessory,
            ccu: this.ccu,
            log: this.log.child(`svc:${def.key}:${name}`),
            Service: this.Service,
            Characteristic: this.Characteristic,
        };
        const handler = def.build(ctx);
        handler.attach(name);
        this.managed.set(uuid, { accessory, handler });
    }
    /**
     * Start the gas meter (polling, history, API) and, when it is placed on
     * the host bridge, attach its platform accessory. Returns the accessory
     * UUID when the gas meter lives on the host bridge.
     */
    async startGas() {
        if (!this.gas) {
            return undefined;
        }
        let uuid;
        if (this.gasPlacement?.kind === 'host') {
            uuid = GasMeter.uuid(this.api.hap);
            const accessory = this.getOrCreateAccessory(uuid, this.gas.name, {
                kind: 'gas',
                id: 'gas-meter',
                service: 'GasMeter',
                name: this.gas.name,
            });
            this.gas.attach(accessory);
        }
        try {
            await this.storage.ensureRoot();
            await this.gas.start();
        }
        catch (err) {
            this.log.error('Gas meter could not start: %s', err.message);
        }
        return uuid;
    }
    /** A cached host gas accessory whose gas meter now lives on a multi-bridge (or is off) is removed. */
    dropMovedGasAccessory(gasUuid) {
        const cachedGas = [...this.cachedAccessories.values()]
            .filter((a) => a.context?.kind === 'gas' && a.UUID !== gasUuid);
        if (cachedGas.length === 0) {
            return;
        }
        for (const a of cachedGas) {
            this.cachedAccessories.delete(a.UUID);
        }
        this.log.info('Removing the cached gas meter accessory of this block (now on a multi-bridge or off)');
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, cachedGas);
    }
    async siblingsOf(address) {
        return this.devicesMemo === undefined ? undefined : deviceChannels(await this.devicesMemo, address);
    }
    async fetchChannel(address, fallbackName) {
        /* c8 ignore next 3 — same unreachable-in-prod guard as attachChannel/Variable/Program */
        if (!this.ccu) {
            throw new Error('CCU client not initialized');
        }
        this.devicesMemo ??= this.ccu.listDevices();
        return findChannel(await this.devicesMemo, address, fallbackName);
    }
    /**
     * Accessory UUID. With `hapHomematicIdentity` and a `uuidSeed` from the
     * importer, reuse hap-homematic's UUID so HomeKit keeps the accessory
     * (name, room, automations) when its bridge identity is transplanted.
     */
    accessoryUuid(defaultSeed, uuidSeed) {
        const seed = this.usesLegacyIdentity(uuidSeed) ? uuidSeed : defaultSeed;
        return this.api.hap.uuid.generate(seed);
    }
    usesLegacyIdentity(uuidSeed) {
        return this.resolved?.hapHomematicIdentity === true
            && typeof uuidSeed === 'string' && uuidSeed.length > 0;
    }
    /** Accessory Information SerialNumber = the accessory's stable key, so HomeKit does not show the Homebridge default. */
    setSerial(accessory, key) {
        accessory.getService(this.Service.AccessoryInformation)?.setCharacteristic(this.Characteristic.SerialNumber, key);
    }
    getOrCreateAccessory(uuid, displayName, context) {
        const existing = this.cachedAccessories.get(uuid);
        if (existing) {
            Object.assign(existing.context, context);
            // If the user renamed the accessory (or imported a hap-homematic
            // backup with custom HomeKit names), update the cached accessory's
            // display name + AccessoryInformation Name characteristic so
            // HomeKit shows the new name. Note: HomeKit caches the room/name
            // pairing on the device side too, so this only takes effect for
            // *newly-paired* HomeKit hubs — already-paired accessories keep
            // the user's manual rename in the Home app.
            if (existing.displayName !== displayName) {
                existing.displayName = displayName;
                const infoSvc = existing.getService(this.Service.AccessoryInformation);
                if (infoSvc) {
                    infoSvc.setCharacteristic(this.Characteristic.Name, displayName);
                }
            }
            this.api.updatePlatformAccessories([existing]);
            return existing;
        }
        const accessory = new this.api.platformAccessory(displayName, uuid);
        accessory.context = context;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.set(uuid, accessory);
        return accessory;
    }
}
//# sourceMappingURL=platform.js.map
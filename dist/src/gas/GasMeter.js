import { join } from 'node:path';
import { GasCcuReader } from './ccuReader.js';
import { GAS_ACCESSORY_SEED, GasMeterServices } from './hap.js';
import { credentialKey } from './history.js';
import { handleGas } from './route.js';
import { GasApiServer } from './server.js';
import { GasService } from './service.js';
import { GAS_TOKEN_FILE, loadOrCreateToken } from './token.js';
export const GAS_HISTORY_DIR = 'gas';
/**
 * The gas meter of one platform block: polling and history (GasService),
 * the HomeKit accessory (on the host bridge or a multi-bridge) and the
 * optional LAN API. It starts independently of the XML-RPC event
 * subscriptions: the device is polled, so a firewalled event port does not
 * block it.
 */
export class GasMeter {
    opts;
    service;
    services;
    last;
    server;
    /** The bound API port, once listening. */
    apiPort;
    constructor(opts) {
        this.opts = opts;
        const { settings, ccu, log } = opts;
        const reader = new GasCcuReader(opts.session, {
            authBackoffMs: settings.pollIntervalMs,
            now: opts.deps?.now,
            redact: [settings.address, ccu.host, ccu.username ?? ''],
        });
        this.service = new GasService(settings, join(opts.storageRoot, GAS_HISTORY_DIR), log, {
            ...opts.deps,
            reader,
            authKey: credentialKey(ccu.host, ccu.username ?? '', ccu.password ?? ''),
            onValues: (values) => this.apply(values),
        });
    }
    /** The HomeKit UUID of the gas meter accessory. */
    static uuid(hap) {
        return hap.uuid.generate(GAS_ACCESSORY_SEED);
    }
    get name() {
        return this.opts.settings.name;
    }
    /** Publish the values on `accessory` from now on (host: a PlatformAccessory; multi-bridge: a HAP Accessory). */
    attach(accessory) {
        this.services = new GasMeterServices(this.opts.hap, accessory, this.opts.settings.name);
        if (this.last)
            this.services.apply(this.last);
    }
    /** A new bridged HAP accessory carrying the gas meter, for a multi-bridge. */
    createBridgedAccessory() {
        const { hap } = this.opts;
        const accessory = new hap.Accessory(this.opts.settings.name, GasMeter.uuid(hap));
        this.attach(accessory);
        return accessory;
    }
    apply(values) {
        this.last = values;
        try {
            this.services?.apply(values);
        }
        catch (err) {
            this.opts.log.warn('Gas meter: could not update HomeKit: %s', err.message);
        }
    }
    async start() {
        await this.service.start();
        const api = this.opts.settings.api;
        if (!api) {
            this.opts.log.info('Gas meter: LAN API off (set gas.api.bindAddress to serve /v1/gas).');
            return;
        }
        try {
            const tokenFile = join(this.opts.storageRoot, GAS_TOKEN_FILE);
            const { token, created } = await loadOrCreateToken(tokenFile);
            const server = new GasApiServer({
                bindAddress: api.bindAddress,
                port: api.port,
                token,
                handle: (url, nowMs) => handleGas(this.service, url, nowMs),
                warn: (m) => this.opts.log.warn('Gas meter: %s', m),
                now: this.opts.deps?.now,
            });
            this.apiPort = await server.start();
            this.server = server;
            this.opts.log.info('Gas meter: LAN API on port %d; bearer token %s %s', this.apiPort, created ? 'created in' : 'in', tokenFile);
        }
        catch (err) {
            // The error code only: the message would carry the bind address.
            this.opts.log.error('Gas meter: LAN API could not start (%s)', err.code ?? 'error');
        }
    }
    async stop() {
        await this.server?.stop();
        this.server = undefined;
        await this.service.stop();
    }
}
//# sourceMappingURL=GasMeter.js.map
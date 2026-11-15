import { join } from 'node:path';
import type { HAP } from 'homebridge';
import type { PrefixedLogger } from '../util/logger.js';
import { GasCcuReader, type SharedCcuSession } from './ccuReader.js';
import type { GasSettings } from './config.js';
import type { CharValues } from './definitions.js';
import { GAS_ACCESSORY_SEED, GasMeterServices, type GasAccessory } from './hap.js';
import { credentialKey } from './history.js';
import { handleGas } from './route.js';
import { GasApiServer } from './server.js';
import { GasService, type GasServiceDeps } from './service.js';
import { GAS_TOKEN_FILE, loadOrCreateToken } from './token.js';

export const GAS_HISTORY_DIR = 'gas';

export interface GasMeterOptions {
  settings: GasSettings;
  hap: HAP;
  /** The plugin's shared CCU JSON-RPC session (`CcuClient.api`). */
  session: SharedCcuSession;
  /** CCU host and user, for the backoff fingerprint and for masking error texts. */
  ccu: { host: string; username?: string; password?: string };
  /** The plugin's folder in the Homebridge storage path. */
  storageRoot: string;
  log: PrefixedLogger;
  /** Test hooks. */
  deps?: Partial<Pick<GasServiceDeps, 'now' | 'setTimer' | 'clearTimer'>>;
}

/**
 * The gas meter of one platform block: polling and history (GasService),
 * the HomeKit accessory (on the host bridge or a multi-bridge) and the
 * optional LAN API. It starts independently of the XML-RPC event
 * subscriptions: the device is polled, so a firewalled event port does not
 * block it.
 */
export class GasMeter {
  readonly service: GasService;
  private services: GasMeterServices | undefined;
  private last: CharValues | undefined;
  private server: GasApiServer | undefined;
  /** The bound API port, once listening. */
  apiPort: number | undefined;

  constructor(private readonly opts: GasMeterOptions) {
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
  static uuid(hap: HAP): string {
    return hap.uuid.generate(GAS_ACCESSORY_SEED);
  }

  get name(): string {
    return this.opts.settings.name;
  }

  /** Publish the values on `accessory` from now on (host: a PlatformAccessory; multi-bridge: a HAP Accessory). */
  attach(accessory: GasAccessory): void {
    this.services = new GasMeterServices(this.opts.hap, accessory, this.opts.settings.name);
    if (this.last) this.services.apply(this.last);
  }

  /** A new bridged HAP accessory carrying the gas meter, for a multi-bridge. */
  createBridgedAccessory(): InstanceType<HAP['Accessory']> {
    const { hap } = this.opts;
    const accessory = new hap.Accessory(this.opts.settings.name, GasMeter.uuid(hap));
    this.attach(accessory);
    return accessory;
  }

  private apply(values: CharValues): void {
    this.last = values;
    try {
      this.services?.apply(values);
    } catch (err) {
      this.opts.log.warn('Gas meter: could not update HomeKit: %s', (err as Error).message);
    }
  }

  async start(): Promise<void> {
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
      this.opts.log.info('Gas meter: LAN API on port %d; bearer token %s %s', this.apiPort,
        created ? 'created in' : 'in', tokenFile);
    } catch (err) {
      // The error code only: the message would carry the bind address.
      this.opts.log.error('Gas meter: LAN API could not start (%s)', (err as NodeJS.ErrnoException).code ?? 'error');
    }
  }

  async stop(): Promise<void> {
    await this.server?.stop();
    this.server = undefined;
    await this.service.stop();
  }
}

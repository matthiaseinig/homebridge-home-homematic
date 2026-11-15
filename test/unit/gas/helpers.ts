import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { afterEach, vi } from 'vitest';
import type { Logging } from 'homebridge';
import { CcuJsonRpcClient } from '../../../src/ccu/CcuJsonRpcClient.js';
import { normalizeGasConfig, type GasSettings } from '../../../src/gas/config.js';
import { GasCcuReader } from '../../../src/gas/ccuReader.js';
import { PrefixedLogger } from '../../../src/util/logger.js';

/** Synthesized test identity: not a real device address, user or password. */
export const ADDRESS = 'TEST000001';
export const USER = 'gas-reader-test';
export const PASSWORD = 'Synthetic-Pa55-word';
export const HOST = '127.0.0.1';

const dirs: string[] = [];
const servers: FakeCcu[] = [];

export async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'hb-homematic-gas-test-'));
  dirs.push(d);
  return d;
}

export function cleanup(): void {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
}

export interface WireCall {
  method: string;
  params: Record<string, unknown>;
  path: string;
  httpMethod: string;
}

type Handler = (call: WireCall) => { result?: unknown; error?: unknown } | undefined;

/**
 * A fake CCU JSON-RPC endpoint on 127.0.0.1. It keeps real sessions (login
 * returns an id, logout removes it, a call with an unknown id gets the CCU's
 * `access denied` answer), serves channel 0 flags and the channel's VALUES
 * paramset, and records everything that arrives on the wire. With
 * `noRights` a login works but every data call is refused like a CCU user
 * without the rights for the device.
 */
export class FakeCcu {
  readonly calls: WireCall[] = [];
  readonly sessions = new Set<string>();
  logins = 0;
  /** Sessions handed out by successful logins. */
  created = 0;
  logouts = 0;
  rejectLogin = false;
  noRights = false;
  unreach: unknown = false;
  lowbat: unknown = false;
  values: Record<string, unknown> = { GAS_ENERGY_COUNTER: '100.000000', GAS_POWER: '0.000000' };
  description: unknown = [
    { NAME: 'GAS_ENERGY_COUNTER', UNIT: 'm3', TYPE: 'FLOAT' },
    { NAME: 'GAS_POWER', UNIT: 'm3', TYPE: 'FLOAT' },
    { NAME: 'ENERGY_COUNTER', UNIT: 'Wh', TYPE: 'FLOAT' },
  ];
  /** Answer handler that runs first; return undefined to fall through. */
  handler: Handler | undefined;
  private next = 1;
  private server: Server | undefined;
  port = 0;

  async start(): Promise<this> {
    const server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
    this.server = server;
    const addr = server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    servers.push(this);
    return this;
  }

  close(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections();
    });
  }

  /** Forget every session, as the CCU does after its session timeout or a reboot. */
  expireSessions(): void {
    this.sessions.clear();
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: { method?: string; params?: Record<string, unknown> } = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      // recorded below with an empty method
    }
    const call: WireCall = {
      method: String(body.method ?? ''),
      params: body.params ?? {},
      path: req.url ?? '',
      httpMethod: req.method ?? '',
    };
    this.calls.push(call);
    const answer = this.handler?.(call) ?? this.answer(call);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: '1.1', result: null, error: null, ...answer }));
  }

  private answer(call: WireCall): { result?: unknown; error?: unknown } {
    const p = call.params;
    if (call.method === 'Session.login') {
      this.logins += 1;
      if (this.rejectLogin || p.username !== USER || p.password !== PASSWORD) {
        // Echo the input like a careless server would: the client must not log it.
        return { error: { code: 501, message: `invalid login for ${String(p.username)}/${String(p.password)}` } };
      }
      const sid = `sid${this.next++}x`;
      this.sessions.add(sid);
      this.created += 1;
      return { result: `@${sid}@` };
    }
    if (!this.sessions.has(String(p._session_id_))) {
      return { error: { code: 400, message: 'access denied ( 1 )' } };
    }
    if (call.method === 'Session.logout') {
      this.logouts += 1;
      this.sessions.delete(String(p._session_id_));
      return { result: true };
    }
    if (this.noRights) {
      return { error: { code: 400, message: 'access denied ( 2 )' } };
    }
    switch (call.method) {
      case 'Interface.getValue':
        if (p.address !== `${ADDRESS}:0`) return { error: { code: 501, message: `unknown address ${String(p.address)}` } };
        if (p.valueKey === 'UNREACH') return { result: this.unreach };
        if (p.valueKey === 'LOWBAT') return { result: this.lowbat };
        return { error: { code: 501, message: 'unknown datapoint' } };
      case 'Interface.getParamset':
        if (p.address !== `${ADDRESS}:1`) return { error: { code: 501, message: `unknown address ${String(p.address)}` } };
        return { result: this.values };
      case 'Interface.getParamsetDescription':
        return { result: this.description };
      default:
        return { error: { code: 501, message: 'unknown method' } };
    }
  }
}

export async function fakeCcu(): Promise<FakeCcu> {
  return new FakeCcu().start();
}

/** A logger that keeps every formatted line, to check that no secret is ever logged. */
export function recordingLog(): Logging & { lines: string[] } {
  const lines: string[] = [];
  const fmt = (level: string) => (msg: string, ...args: unknown[]): void => {
    lines.push(`${level} ${format(msg, ...args)}`);
  };
  const log = vi.fn(fmt('log')) as unknown as Logging & { lines: string[] };
  Object.assign(log, {
    info: fmt('info'),
    warn: fmt('warn'),
    error: fmt('error'),
    debug: fmt('debug'),
    success: fmt('success'),
    log: fmt('log'),
    prefix: 'test',
    lines,
  });
  return log;
}

export function prefixed(log: Logging): PrefixedLogger {
  return new PrefixedLogger(log, 'gas');
}

/** The plugin's shared JSON-RPC session against the fake CCU. */
export function sharedSession(port: number, log: Logging = recordingLog(), timeoutMs = 2000, now?: () => number): CcuJsonRpcClient {
  return new CcuJsonRpcClient({
    host: HOST,
    port,
    timeoutMs,
    now,
    auth: { username: USER, password: PASSWORD },
    log: new PrefixedLogger(log, 'api'),
  });
}

export function reader(session: CcuJsonRpcClient, now: () => number, backoffMs = 60_000): GasCcuReader {
  return new GasCcuReader(session, { authBackoffMs: backoffMs, now, redact: [ADDRESS, HOST, USER] });
}

/** Settings for the fake device, with optional overrides of the raw `gas` block. */
export function gasSettings(extra: Record<string, unknown> = {}): GasSettings {
  const { config, errors } = normalizeGasConfig({
    enabled: true,
    address: `BidCos-RF.${ADDRESS}:1`,
    timeZone: 'Europe/Berlin',
    ...extra,
  });
  if (errors.length > 0) throw new Error(errors.join('; '));
  return config;
}

/** A clock the test moves by hand. */
export function clock(start: number): { now: () => number; set: (t: number) => void; add: (ms: number) => void } {
  let t = start;
  return { now: () => t, set: (n) => { t = n; }, add: (ms) => { t += ms; } };
}

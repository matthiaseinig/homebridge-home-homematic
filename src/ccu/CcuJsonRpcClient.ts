/**
 * Modern CCU control-plane client using the JSON-RPC API at
 * /api/homematic.cgi. This replaces the legacy ReGa-script transport
 * that the predecessor plugins (thkl/homebridge-homematic, hap-homematic,
 * AlexanderSchmutz/homebridge-homematic-asaw) all used.
 *
 * Why JSON-RPC instead of ReGa scripts:
 *   - Modern, structured API; methods listed via `system.listMethods`.
 *   - Returns typed JSON, not stringly-typed XML scraped from script
 *     stdout.
 *   - Properly authenticated via `Session.login` + a `_session_id_`
 *     parameter on every authenticated call.
 *   - Doesn't have the script-context permission hole where even an
 *     Admin user's `root.Devices().EnumIDs()` returns empty on some
 *     RaspberryMatic builds.
 *
 * **Event delivery is NOT migrated** — JSON-RPC has no event-push
 * mechanism. The EventServer + per-interface XML-RPC subscriptions
 * remain unchanged. This client is for the *control plane* only:
 * discovery, variable I/O, program execution, value get/set.
 */

import { Buffer } from 'node:buffer';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest, type Agent as HttpsAgent } from 'node:https';
import type { PrefixedLogger } from '../util/logger.js';
import type { CcuDevice, CcuInterfaceId, CcuProgram, CcuVariable } from '../types.js';

const API_PORT_HTTP = 80;
const API_PORT_HTTPS = 443;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const SAFE_NAME_RE = /^[A-Za-z0-9_\-. äöüÄÖÜß]{1,200}$/;
/**
 * Session errors the CCU raises before it runs the method: an expired or
 * unknown session id, and also missing rights (the CCU answers both with
 * `access denied`). Matched on the raw CCU text, before masking. Only these
 * (or HTTP-like codes 401/403) may replace the session and retry a method
 * that changes something (`Interface.setValue`, `Program.execute`, ...).
 */
const SESSION_ERROR_RE = new RegExp([
  String.raw`^\s*access denied\b`,
  String.raw`\binvalid session\b`,
  String.raw`\bsession (?:id )?(?:is )?(?:invalid|expired|unknown|not found)\b`,
  String.raw`\bsession expired\b`,
  String.raw`\bnot authenticated\b`,
  String.raw`\bunauthori[sz]ed\b`,
].join('|'), 'i');
/** Looser hint, used only for read methods (a repeated read is harmless). */
const SESSION_HINT_RE = /session|login/i;
/** Read methods: retried on the looser hint too. Every other method only on a session error. */
const READ_METHOD_RE = /\.(?:get|list|describe|is|has)[A-Za-z]*$/;
/** A method refused even with a fresh session waits this long, doubling up to the maximum. */
export const PERMISSION_BACKOFF_MS = 10 * 60_000;
export const MAX_PERMISSION_BACKOFF_MS = 60 * 60_000;

/** One CCU session: requests in flight, and whether it was replaced (logged out once drained). */
interface Session {
  readonly sid: string;
  inflight: number;
  retired: boolean;
  loggedOut: boolean;
  /** Highest request number that succeeded on this session (proof the session was valid then). */
  okSeq: number;
}

/** Per-method backoff after the CCU refused a method with a fresh session (missing rights). */
interface Denied {
  until: number;
  waitMs: number;
}

export interface CcuJsonRpcOptions {
  host: string;
  useTls?: boolean;
  /** Override the default 80/443 API port (mainly for tests). */
  port?: number;
  timeoutMs?: number;
  /**
   * Agent for the HTTPS requests (with `useTls`), for example one that pins
   * the CCU certificate. Without it the CCU's self-signed certificate is
   * accepted unverified, as before.
   */
  tlsAgent?: HttpsAgent;
  auth?: { username: string; password: string };
  log: PrefixedLogger;
  now?: () => number;
}

/**
 * What went wrong: `auth` the login was rejected, `session` the CCU refused
 * the call for its session (no credentials configured, or the session was
 * replaced meanwhile), `permission` the CCU refused the method also with a
 * fresh session (missing rights; the method then waits, see
 * PERMISSION_BACKOFF_MS), `protocol` the CCU answered with another error or
 * no JSON, `network` no usable HTTP answer.
 */
export type JsonRpcErrorKind = 'auth' | 'session' | 'permission' | 'protocol' | 'network';

export class JsonRpcError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public override readonly cause?: unknown,
    public readonly kind: JsonRpcErrorKind = 'protocol',
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

interface JsonRpcResponse<T> {
  version?: string;
  result?: T;
  error?: { name?: string; code?: number; message?: string } | null;
}

/** Raw API surface — exposed for callers that need methods we don't wrap yet. */
export class CcuJsonRpcClient {
  private readonly host: string;
  private readonly useTls: boolean;
  private readonly portOverride: number | undefined;
  private readonly timeoutMs: number;
  private readonly tlsAgent: HttpsAgent | undefined;
  private readonly auth?: { username: string; password: string };
  private readonly log: PrefixedLogger;
  private session: Session | undefined;
  private loginInFlight: Promise<Session> | undefined;
  private seq = 0;
  private readonly denied = new Map<string, Denied>();
  private readonly now: () => number;

  constructor(opts: CcuJsonRpcOptions) {
    this.host = opts.host;
    this.useTls = Boolean(opts.useTls);
    this.portOverride = opts.port;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.tlsAgent = opts.tlsAgent;
    this.auth = opts.auth;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
  }

  /** Drop the cached session (it is logged out once its requests are done); the next call logs in again. */
  invalidateSession(): void {
    if (this.session) {
      this.retire(this.session);
    }
  }

  /** True while a session is cached. */
  get hasSession(): boolean {
    return this.session !== undefined;
  }

  /**
   * Log the cached session out (best effort) and forget it. Used on
   * shutdown, so no session is left open on the CCU until its timeout.
   */
  async logout(): Promise<void> {
    await this.loginInFlight?.catch(() => undefined);
    const s = this.session;
    if (s) {
      await this.retire(s);
    }
  }

  /**
   * Invoke a JSON-RPC method, automatically attaching `_session_id_` if
   * authentication is configured.
   *
   * Session handling, shared by every caller of this client:
   *   - A session error (`access denied`, an invalid session) replaces the
   *     session once and retries, unless a later request on the same
   *     session succeeded (then the session is fine and the method itself
   *     is refused). Concurrent callers share one new login; a caller whose
   *     session was already replaced just retries on the new one.
   *   - A method that is refused again with the fresh session is a rights
   *     problem: the session is kept, only this call fails (kind
   *     `permission`) and the method waits PERMISSION_BACKOFF_MS (doubling
   *     to MAX_PERMISSION_BACKOFF_MS) before it is sent again; one warning is
   *     logged. A success of the method ends its wait.
   *   - A method that changes something is retried only on a real session
   *     error, never on a loose hint in an error text.
   *   - A replaced session is logged out once no request uses it any more.
   */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const key = deniedKey(method, params);
    const denied = this.denied.get(key);
    if (denied && denied.until > this.now()) {
      throw new JsonRpcError(`${method}: refused by the CCU (missing rights), paused until ${new Date(denied.until).toISOString()}`,
        undefined, undefined, 'permission');
    }
    return this.callOnce<T>(method, params, false);
  }

  private async callOnce<T>(method: string, params: Record<string, unknown>, retried: boolean): Promise<T> {
    const session = await this.ensureSession();
    const seq = ++this.seq;
    const body = Buffer.from(JSON.stringify({
      version: '1.1',
      method,
      params: session ? { ...params, _session_id_: session.sid } : params,
    }), 'utf8');
    let raw: Buffer;
    if (session) {
      session.inflight += 1;
    }
    try {
      raw = await this.postJson(body);
    } finally {
      if (session) {
        session.inflight -= 1;
        void this.drain(session);
      }
    }
    const text = raw.toString('utf8');
    let parsed: JsonRpcResponse<T>;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new JsonRpcError(`malformed JSON-RPC response from ${method}`);
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new JsonRpcError(`malformed JSON-RPC response from ${method}`);
    }
    if (!parsed.error) {
      if (session) {
        session.okSeq = Math.max(session.okSeq, seq);
      }
      this.denied.delete(deniedKey(method, params));
      return parsed.result as T;
    }
    const code = parsed.error.code;
    const rawMessage = String(parsed.error.message ?? 'unknown error');
    // Detect on the raw text; mask only what is reported.
    const sessionError = code === 401 || code === 403 || SESSION_ERROR_RE.test(rawMessage)
      || (READ_METHOD_RE.test(method) && SESSION_HINT_RE.test(rawMessage));
    const message = this.scrub(rawMessage, session?.sid);
    if (!sessionError) {
      throw new JsonRpcError(`${method}: ${message}`, code, undefined, 'protocol');
    }
    if (!session) {
      throw new JsonRpcError(`${method}: ${message}`, code, undefined, 'session');
    }
    if (this.session !== session) {
      // Replaced meanwhile by another caller: retry once on the current session, no new login.
      if (!retried) {
        return this.callOnce<T>(method, params, true);
      }
      throw new JsonRpcError(`${method}: ${message}`, code, undefined, 'session');
    }
    if (retried || session.okSeq > seq) {
      // A fresh session, or one proven valid by a later request: the method itself is refused.
      throw this.denyMethod(method, params, `${method}: ${message}`, code);
    }
    this.log.debug('JSON-RPC session refused, logging in again');
    void this.retire(session);
    return this.callOnce<T>(method, params, true);
  }

  /** Put a method refused with a valid session on its backoff; warn once per method. */
  private denyMethod(method: string, params: Record<string, unknown>, message: string, code: number | undefined): JsonRpcError {
    const key = deniedKey(method, params);
    const prev = this.denied.get(key);
    const now = this.now();
    if (!prev || prev.until <= now) {
      const waitMs = prev ? Math.min(MAX_PERMISSION_BACKOFF_MS, prev.waitMs * 2) : PERMISSION_BACKOFF_MS;
      this.denied.set(key, { until: now + waitMs, waitMs });
      if (!prev) {
        this.log.warn('The CCU refuses %s%s for the configured CCU user (missing rights?); it is retried after %d min, then less often',
          method, typeof params.interface === 'string' ? ` on ${params.interface}` : '', Math.round(waitMs / 60_000));
      }
    }
    return new JsonRpcError(message, code, undefined, 'permission');
  }

  // --- session ------------------------------------------------------

  /** Stop handing `s` out; it is logged out (once) as soon as no request uses it. */
  private async retire(s: Session): Promise<void> {
    if (this.session === s) {
      this.session = undefined;
    }
    s.retired = true;
    await this.drain(s);
  }

  /** Log out a replaced session that no request uses any more. Exactly once per session. */
  private async drain(s: Session): Promise<void> {
    if (!s.retired || s.inflight > 0 || s.loggedOut) {
      return;
    }
    s.loggedOut = true;
    const body = Buffer.from(JSON.stringify({
      version: '1.1',
      method: 'Session.logout',
      params: { _session_id_: s.sid },
    }), 'utf8');
    try {
      await this.postJson(body);
    } catch (err) {
      this.log.debug('Session.logout failed: %s', (err as Error).message);
    }
  }

  /** Mask the password and session ids in a CCU error text, which may echo the request. */
  private scrub(text: string, sid?: string): string {
    let out = String(text);
    for (const secret of [this.auth?.password, sid, this.session?.sid]) {
      if (secret && secret.length > 0) {
        out = out.split(secret).join('***');
      }
    }
    return out;
  }

  private async ensureSession(): Promise<Session | undefined> {
    if (!this.auth) {
      return undefined;
    }
    if (this.session) {
      return this.session;
    }
    // Concurrent callers share one login, so no session is created and lost.
    this.loginInFlight ??= this.login(this.auth).finally(() => {
      this.loginInFlight = undefined;
    });
    return this.loginInFlight;
  }

  private async login(auth: { username: string; password: string }): Promise<Session> {
    const body = Buffer.from(JSON.stringify({
      version: '1.1',
      method: 'Session.login',
      params: { username: auth.username, password: auth.password },
    }), 'utf8');
    const raw = await this.postJson(body);
    const text = raw.toString('utf8');
    let parsed: JsonRpcResponse<string>;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new JsonRpcError('CCU auth: malformed JSON response');
    }
    if (parsed && typeof parsed === 'object' && parsed.error) {
      throw new JsonRpcError(`CCU auth failed: ${this.scrub(parsed.error.message ?? 'unknown')}`, parsed.error.code, undefined, 'auth');
    }
    if (!parsed || typeof parsed.result !== 'string' || parsed.result.length === 0) {
      throw new JsonRpcError('CCU auth: empty session id', undefined, undefined, 'auth');
    }
    // The CCU may wrap the sid in literal '@' chars; normalise.
    const session: Session = { sid: parsed.result.replace(/^@+|@+$/g, ''), inflight: 0, retired: false, loggedOut: false, okSeq: 0 };
    this.session = session;
    this.log.debug('Acquired CCU session (length=%d)', session.sid.length);
    return session;
  }

  // --- high-level helpers -------------------------------------------

  /**
   * One-shot CCU device tree: every device with its channels embedded.
   * Maps RaspberryMatic's `Device.listAllDetail` into our internal shape.
   */
  async listDevices(): Promise<CcuDevice[]> {
    interface RawChannel {
      name?: string;
      address?: string;
      index?: number | string;
      channelType?: string;
    }
    interface RawDevice {
      name?: string;
      address?: string;
      type?: string;
      interface?: string;
      channels?: RawChannel[];
    }
    const result = await this.call<RawDevice[]>('Device.listAllDetail');
    return result.map((d) => ({
      address: d.address ?? '',
      name: d.name ?? '',
      type: d.type ?? '',
      interface: asInterfaceId(d.interface ?? ''),
      channels: (d.channels ?? []).map((c) => ({
        address: c.address ?? '',
        name: c.name ?? '',
        index: typeof c.index === 'number' ? c.index : parseInt(String(c.index ?? 0), 10) || 0,
        type: c.channelType ?? '',
      })),
    }));
  }

  async listVariables(): Promise<CcuVariable[]> {
    interface RawVar {
      id?: string;
      name?: string;
      type?: string; // 'BOOL' | 'FLOAT' | 'ENUM' | 'STRING'
      subtype?: string | number;
      minValue?: number | string;
      maxValue?: number | string;
      unit?: string;
      value?: unknown;
      valueList?: string[];
    }
    const raw = await this.call<RawVar[]>('SysVar.getAll');
    return raw.map((v) => {
      const valuetype = mapVariableValueType(v.type);
      const numericValue = (typeof v.value === 'number')
        ? v.value
        : Number.parseFloat(String(v.value ?? ''));
      let value: boolean | number | string;
      if (valuetype === 2) {
        value = String(v.value).toLowerCase() === 'true' || v.value === true || v.value === 1 || v.value === '1';
      } else if (valuetype === 4) {
        value = Number.isFinite(numericValue) ? numericValue : 0;
      } else {
        value = String(v.value ?? '');
      }
      return {
        id: v.id ?? '',
        name: v.name ?? '',
        valuetype,
        subtype: typeof v.subtype === 'number' ? v.subtype : Number.parseInt(String(v.subtype ?? 0), 10) || 0,
        minValue: numberOrUndef(v.minValue),
        maxValue: numberOrUndef(v.maxValue),
        unit: v.unit || undefined,
        enumValues: v.valueList,
        value,
      };
    });
  }

  async listPrograms(): Promise<CcuProgram[]> {
    interface RawProgram { id?: string; name?: string }
    const raw = await this.call<RawProgram[]>('Program.getAll');
    return raw.map((p) => ({ id: p.id ?? '', name: p.name ?? '' }));
  }

  async listRooms(): Promise<{ id: string; name: string; channelIds: string[] }[]> {
    interface RawRoom { id?: string; name?: string; channelIds?: (string | number)[] }
    const raw = await this.call<RawRoom[]>('Room.getAll');
    return raw.map((r) => ({
      id: String(r.id ?? ''),
      name: r.name ?? '',
      channelIds: (r.channelIds ?? []).map((c) => String(c)),
    }));
  }

  /**
   * Discover the XML-RPC ports each CCU interface is actually listening on.
   * On RaspberryMatic the BidCos-RF / HmIP-RF / VirtualDevices ports are
   * exposed externally on a +30000 offset (32001 / 32010 / 39292), not the
   * historical 2001 / 2010 / 9292 — those only bind on localhost. Querying
   * the CCU avoids hard-coding the offset.
   *
   * Some CCUs return only a `url` like `xmlrpc://127.0.0.1:32001`; we parse
   * the port out of either shape.
   */
  async listInterfaces(): Promise<Array<{ name: string; port: number; url?: string }>> {
    interface RawInterface { name?: string; info?: string; port?: number | string; url?: string }
    const raw = await this.call<RawInterface[]>('Interface.listInterfaces');
    const out: Array<{ name: string; port: number; url?: string }> = [];
    for (const i of raw ?? []) {
      const name = i.name ?? '';
      if (!name) continue;
      let port = typeof i.port === 'number'
        ? i.port
        : Number.parseInt(String(i.port ?? ''), 10);
      if (!Number.isFinite(port) || port <= 0) {
        const u = parseUrlPort(i.url);
        if (u !== undefined) {
          port = u;
        }
      }
      if (!Number.isFinite(port) || port <= 0) {
        continue;
      }
      out.push({ name, port, url: i.url });
    }
    return out;
  }

  async getInterfaceValue(interfaceName: string, address: string, valueKey: string): Promise<string> {
    return this.call<string>('Interface.getValue', { interface: interfaceName, address, valueKey });
  }

  async setInterfaceValue(
    interfaceName: string,
    address: string,
    valueKey: string,
    type: 'boolean' | 'string' | 'integer' | 'double',
    value: unknown,
  ): Promise<void> {
    await this.call('Interface.setValue', { interface: interfaceName, address, valueKey, type, value });
  }

  async getVariable(name: string): Promise<string> {
    if (!isSafeIdentifier(name)) {
      throw new JsonRpcError(`unsafe variable name: ${name}`);
    }
    const raw = await this.call<string | number | boolean>('SysVar.getValueByName', { name });
    return String(raw);
  }

  async setVariable(name: string, value: string | number | boolean): Promise<void> {
    if (!isSafeIdentifier(name)) {
      throw new JsonRpcError(`unsafe variable name: ${name}`);
    }
    interface RawVar { id?: string; name?: string; type?: string }
    // Look up the SysVar id + type — the JSON-RPC setters need an id.
    const all = await this.call<RawVar[]>('SysVar.getAll');
    const found = all.find((v) => v.name === name);
    if (!found?.id) {
      throw new JsonRpcError(`SysVar not found: ${name}`);
    }
    const t = (found.type ?? '').toUpperCase();
    if (t === 'BOOL') {
      await this.call('SysVar.setBool', { id: found.id, value: Boolean(value) });
    } else if (t === 'FLOAT') {
      const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
      if (!Number.isFinite(n)) {
        throw new JsonRpcError('Cannot store non-finite number in SysVar');
      }
      await this.call('SysVar.setFloat', { id: found.id, value: n });
    } else if (t === 'ENUM') {
      await this.call('SysVar.setEnum', { id: found.id, value });
    } else {
      // STRING or unknown — try generic setValue if it exists, otherwise float.
      await this.call('SysVar.setFloat', { id: found.id, value });
    }
  }

  async runProgram(name: string): Promise<void> {
    if (!isSafeIdentifier(name)) {
      throw new JsonRpcError(`unsafe program name: ${name}`);
    }
    interface RawProgram { id?: string; name?: string }
    const all = await this.call<RawProgram[]>('Program.getAll');
    const found = all.find((p) => p.name === name);
    if (!found?.id) {
      throw new JsonRpcError(`Program not found: ${name}`);
    }
    await this.call('Program.execute', { id: found.id });
  }

  // --- HTTP plumbing ------------------------------------------------

  private postJson(body: Buffer): Promise<Buffer> {
    const port = this.portOverride ?? (this.useTls ? API_PORT_HTTPS : API_PORT_HTTP);
    const reqFn = this.useTls ? httpsRequest : httpRequest;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
    };
    const opts: RequestOptions & { rejectUnauthorized?: boolean } = {
      host: this.host,
      port,
      method: 'POST',
      path: '/api/homematic.cgi',
      headers,
      timeout: this.timeoutMs,
    };
    if (this.useTls && this.tlsAgent) {
      // The agent decides how the certificate is checked; no per-request override.
      opts.agent = this.tlsAgent;
    } else if (this.useTls) {
      opts.rejectUnauthorized = false;
    }
    return new Promise<Buffer>((resolve, reject) => {
      const req = reqFn(opts, (res: IncomingMessage) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new JsonRpcError(`HTTP ${res.statusCode ?? 'unknown'}`, undefined, undefined, 'network'));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            res.destroy(new JsonRpcError('JSON-RPC response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', (err) => reject(new JsonRpcError('JSON-RPC response error', undefined, err, 'network')));
      });
      req.on('timeout', () => {
        req.destroy(new JsonRpcError(`JSON-RPC timeout after ${this.timeoutMs} ms`, undefined, undefined, 'network'));
      });
      req.on('error', (err) => reject(new JsonRpcError('JSON-RPC request failed', undefined, err, 'network')));
      req.write(body);
      req.end();
    });
  }
}

// --- helpers --------------------------------------------------------

/** The per-method backoff key: method and, when given, the CCU interface. */
function deniedKey(method: string, params: Record<string, unknown>): string {
  return `${method}|${typeof params.interface === 'string' ? params.interface : ''}`;
}

export function isSafeIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  if (!SAFE_NAME_RE.test(value)) {
    return false;
  }
  return !/["\\\r\n;]/.test(value);
}

function numberOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') {
    return undefined;
  }
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
}

function mapVariableValueType(type: string | undefined): number {
  switch ((type ?? '').toUpperCase()) {
    case 'BOOL': return 2;
    case 'FLOAT': return 4;
    case 'STRING': return 16;
    case 'ENUM': return 20;
    default: return 0;
  }
}

function parseUrlPort(url: string | undefined): number | undefined {
  if (!url) return undefined;
  // accept e.g. xmlrpc://127.0.0.1:32001/, http://host:80, binary://h:9292
  const m = url.match(/:(\d+)(?:\/|$)/);
  if (!m) return undefined;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function asInterfaceId(name: string): CcuInterfaceId {
  if (name === 'BidCos-RF' || name === 'HmIP-RF' || name === 'BidCos-Wired'
      || name === 'VirtualDevices' || name === 'CUxD') {
    return name;
  }
  if (/hmip/i.test(name)) {
    return 'HmIP-RF';
  }
  if (/cux/i.test(name)) {
    return 'CUxD';
  }
  if (/virt/i.test(name)) {
    return 'VirtualDevices';
  }
  if (/wired/i.test(name)) {
    return 'BidCos-Wired';
  }
  return 'BidCos-RF';
}

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
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
const API_PORT_HTTP = 80;
const API_PORT_HTTPS = 443;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const SAFE_NAME_RE = /^[A-Za-z0-9_\-. äöüÄÖÜß]{1,200}$/;
/**
 * CCU answers that mean "this session is not (or no longer) valid". The CCU
 * says `access denied` for an expired or unknown session id, and also when
 * the user lacks the rights for the call; both get one fresh session.
 */
const SESSION_HINT_RE = /session|access denied|not authenticated|unauthori[sz]ed|login/i;
export class JsonRpcError extends Error {
    code;
    cause;
    kind;
    constructor(message, code, cause, kind = 'protocol') {
        super(message);
        this.code = code;
        this.cause = cause;
        this.kind = kind;
        this.name = 'JsonRpcError';
    }
}
/** Raw API surface — exposed for callers that need methods we don't wrap yet. */
export class CcuJsonRpcClient {
    host;
    useTls;
    portOverride;
    timeoutMs;
    auth;
    log;
    sessionId;
    loginInFlight;
    constructor(opts) {
        this.host = opts.host;
        this.useTls = Boolean(opts.useTls);
        this.portOverride = opts.port;
        this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.auth = opts.auth;
        this.log = opts.log;
    }
    /** Drop the cached session id; the next authenticated call will re-login. */
    invalidateSession() {
        this.sessionId = undefined;
    }
    /** True while a session id is cached. */
    get hasSession() {
        return this.sessionId !== undefined;
    }
    /**
     * Log the cached session out (best effort) and forget it. Used on
     * shutdown, so no session is left open on the CCU until its timeout.
     */
    async logout() {
        await this.loginInFlight?.catch(() => undefined);
        const sid = this.sessionId;
        if (sid !== undefined) {
            await this.abandon(sid);
        }
    }
    /**
     * Invoke a JSON-RPC method, automatically attaching `_session_id_` if
     * authentication is configured. When the CCU refuses the session, it is
     * logged out and replaced once and the call is retried; when the fresh
     * session is refused too, that one is logged out as well and the call
     * fails with kind `session`. Every session this client gives up is logged
     * out, so none is left open on the CCU.
     */
    async call(method, params = {}) {
        return this.callOnce(method, params, false);
    }
    async callOnce(method, params, retried) {
        const sid = await this.ensureSession();
        const body = Buffer.from(JSON.stringify({
            version: '1.1',
            method,
            params: sid ? { ...params, _session_id_: sid } : params,
        }), 'utf8');
        const raw = await this.postJson(body);
        const text = raw.toString('utf8');
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            throw new JsonRpcError(`malformed JSON-RPC response from ${method}`);
        }
        if (parsed === null || typeof parsed !== 'object') {
            throw new JsonRpcError(`malformed JSON-RPC response from ${method}`);
        }
        if (parsed.error) {
            const code = parsed.error.code;
            const message = this.scrub(parsed.error.message ?? 'unknown error', sid);
            const sessionRefused = code === 401 || code === 403 || SESSION_HINT_RE.test(message);
            if (sessionRefused && sid !== undefined) {
                // The session may still exist on the CCU (a rights problem looks the same): log it out.
                await this.abandon(sid);
                if (!retried) {
                    this.log.debug('JSON-RPC session refused, logging in again');
                    return this.callOnce(method, params, true);
                }
            }
            throw new JsonRpcError(`${method}: ${message}`, code, undefined, sessionRefused ? 'session' : 'protocol');
        }
        return parsed.result;
    }
    // --- session ------------------------------------------------------
    /** Forget `sid` if it is still the cached one and log it out (best effort). Exactly one caller does this per session. */
    async abandon(sid) {
        if (this.sessionId !== sid) {
            return;
        }
        this.sessionId = undefined;
        const body = Buffer.from(JSON.stringify({
            version: '1.1',
            method: 'Session.logout',
            params: { _session_id_: sid },
        }), 'utf8');
        try {
            await this.postJson(body);
        }
        catch (err) {
            this.log.debug('Session.logout failed: %s', err.message);
        }
    }
    /** Mask the password and session ids in a CCU error text, which may echo the request. */
    scrub(text, sid) {
        let out = String(text);
        for (const secret of [this.auth?.password, sid, this.sessionId]) {
            if (secret && secret.length > 0) {
                out = out.split(secret).join('***');
            }
        }
        return out;
    }
    async ensureSession() {
        if (!this.auth) {
            return undefined;
        }
        if (this.sessionId) {
            return this.sessionId;
        }
        // Concurrent callers share one login, so no session is created and lost.
        this.loginInFlight ??= this.login(this.auth).finally(() => {
            this.loginInFlight = undefined;
        });
        return this.loginInFlight;
    }
    async login(auth) {
        const body = Buffer.from(JSON.stringify({
            version: '1.1',
            method: 'Session.login',
            params: { username: auth.username, password: auth.password },
        }), 'utf8');
        const raw = await this.postJson(body);
        const text = raw.toString('utf8');
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            throw new JsonRpcError('CCU auth: malformed JSON response');
        }
        if (parsed && typeof parsed === 'object' && parsed.error) {
            throw new JsonRpcError(`CCU auth failed: ${this.scrub(parsed.error.message ?? 'unknown')}`, parsed.error.code, undefined, 'auth');
        }
        if (!parsed || typeof parsed.result !== 'string' || parsed.result.length === 0) {
            throw new JsonRpcError('CCU auth: empty session id', undefined, undefined, 'auth');
        }
        // The CCU may wrap the sid in literal '@' chars; normalise.
        this.sessionId = parsed.result.replace(/^@+|@+$/g, '');
        this.log.debug('Acquired CCU session (length=%d)', this.sessionId.length);
        return this.sessionId;
    }
    // --- high-level helpers -------------------------------------------
    /**
     * One-shot CCU device tree: every device with its channels embedded.
     * Maps RaspberryMatic's `Device.listAllDetail` into our internal shape.
     */
    async listDevices() {
        const result = await this.call('Device.listAllDetail');
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
    async listVariables() {
        const raw = await this.call('SysVar.getAll');
        return raw.map((v) => {
            const valuetype = mapVariableValueType(v.type);
            const numericValue = (typeof v.value === 'number')
                ? v.value
                : Number.parseFloat(String(v.value ?? ''));
            let value;
            if (valuetype === 2) {
                value = String(v.value).toLowerCase() === 'true' || v.value === true || v.value === 1 || v.value === '1';
            }
            else if (valuetype === 4) {
                value = Number.isFinite(numericValue) ? numericValue : 0;
            }
            else {
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
    async listPrograms() {
        const raw = await this.call('Program.getAll');
        return raw.map((p) => ({ id: p.id ?? '', name: p.name ?? '' }));
    }
    async listRooms() {
        const raw = await this.call('Room.getAll');
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
    async listInterfaces() {
        const raw = await this.call('Interface.listInterfaces');
        const out = [];
        for (const i of raw ?? []) {
            const name = i.name ?? '';
            if (!name)
                continue;
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
    async getInterfaceValue(interfaceName, address, valueKey) {
        return this.call('Interface.getValue', { interface: interfaceName, address, valueKey });
    }
    async setInterfaceValue(interfaceName, address, valueKey, type, value) {
        await this.call('Interface.setValue', { interface: interfaceName, address, valueKey, type, value });
    }
    async getVariable(name) {
        if (!isSafeIdentifier(name)) {
            throw new JsonRpcError(`unsafe variable name: ${name}`);
        }
        const raw = await this.call('SysVar.getValueByName', { name });
        return String(raw);
    }
    async setVariable(name, value) {
        if (!isSafeIdentifier(name)) {
            throw new JsonRpcError(`unsafe variable name: ${name}`);
        }
        // Look up the SysVar id + type — the JSON-RPC setters need an id.
        const all = await this.call('SysVar.getAll');
        const found = all.find((v) => v.name === name);
        if (!found?.id) {
            throw new JsonRpcError(`SysVar not found: ${name}`);
        }
        const t = (found.type ?? '').toUpperCase();
        if (t === 'BOOL') {
            await this.call('SysVar.setBool', { id: found.id, value: Boolean(value) });
        }
        else if (t === 'FLOAT') {
            const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
            if (!Number.isFinite(n)) {
                throw new JsonRpcError('Cannot store non-finite number in SysVar');
            }
            await this.call('SysVar.setFloat', { id: found.id, value: n });
        }
        else if (t === 'ENUM') {
            await this.call('SysVar.setEnum', { id: found.id, value });
        }
        else {
            // STRING or unknown — try generic setValue if it exists, otherwise float.
            await this.call('SysVar.setFloat', { id: found.id, value });
        }
    }
    async runProgram(name) {
        if (!isSafeIdentifier(name)) {
            throw new JsonRpcError(`unsafe program name: ${name}`);
        }
        const all = await this.call('Program.getAll');
        const found = all.find((p) => p.name === name);
        if (!found?.id) {
            throw new JsonRpcError(`Program not found: ${name}`);
        }
        await this.call('Program.execute', { id: found.id });
    }
    // --- HTTP plumbing ------------------------------------------------
    postJson(body) {
        const port = this.portOverride ?? (this.useTls ? API_PORT_HTTPS : API_PORT_HTTP);
        const reqFn = this.useTls ? httpsRequest : httpRequest;
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': String(body.length),
        };
        const opts = {
            host: this.host,
            port,
            method: 'POST',
            path: '/api/homematic.cgi',
            headers,
            timeout: this.timeoutMs,
        };
        if (this.useTls) {
            opts.rejectUnauthorized = false;
        }
        return new Promise((resolve, reject) => {
            const req = reqFn(opts, (res) => {
                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                    res.resume();
                    reject(new JsonRpcError(`HTTP ${res.statusCode ?? 'unknown'}`, undefined, undefined, 'network'));
                    return;
                }
                const chunks = [];
                let total = 0;
                res.on('data', (chunk) => {
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
export function isSafeIdentifier(value) {
    if (typeof value !== 'string' || value.length === 0) {
        return false;
    }
    if (!SAFE_NAME_RE.test(value)) {
        return false;
    }
    return !/["\\\r\n;]/.test(value);
}
function numberOrUndef(v) {
    if (v === undefined || v === null || v === '') {
        return undefined;
    }
    const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
    return Number.isFinite(n) ? n : undefined;
}
function mapVariableValueType(type) {
    switch ((type ?? '').toUpperCase()) {
        case 'BOOL': return 2;
        case 'FLOAT': return 4;
        case 'STRING': return 16;
        case 'ENUM': return 20;
        default: return 0;
    }
}
function parseUrlPort(url) {
    if (!url)
        return undefined;
    // accept e.g. xmlrpc://127.0.0.1:32001/, http://host:80, binary://h:9292
    const m = url.match(/:(\d+)(?:\/|$)/);
    if (!m)
        return undefined;
    const n = Number.parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}
function asInterfaceId(name) {
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
//# sourceMappingURL=CcuJsonRpcClient.js.map
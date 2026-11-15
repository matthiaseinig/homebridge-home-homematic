import { JsonRpcError } from '../ccu/CcuJsonRpcClient.js';
/**
 * The only JSON-RPC methods the gas meter ever sends, through the plugin's
 * shared CCU session. Every request goes through `assertAllowed`: there is
 * no setter, script, program or system variable call for this device, and
 * the paramset methods are limited to `VALUES`. (`Session.login` and
 * `Session.logout` are sent by the shared session itself.)
 */
export const GAS_CCU_METHODS = Object.freeze([
    'Interface.getValue',
    'Interface.getParamset',
    'Interface.getParamsetDescription',
]);
/** Longest wait between attempts after rejected logins or refused sessions. */
export const MAX_AUTH_BACKOFF_MS = 10 * 60_000;
export class GasCcuError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.kind = kind;
        this.name = 'GasCcuError';
    }
}
/** Throws unless `method` is on the allow-list and a paramset call asks for `VALUES`. */
export function assertAllowed(method, params) {
    if (!GAS_CCU_METHODS.includes(method)) {
        throw new GasCcuError('refused', `CCU method ${method.slice(0, 40)} is not allowed for the gas meter`);
    }
    if (method === 'Interface.getParamset' && params.paramsetKey !== 'VALUES') {
        throw new GasCcuError('refused', 'only the VALUES paramset may be read');
    }
    if (method === 'Interface.getParamsetDescription' && params.paramsetType !== 'VALUES') {
        throw new GasCcuError('refused', 'only the VALUES paramset may be described');
    }
}
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const MAX_MESSAGE = 120;
/**
 * Read-only access of the gas meter to the plugin's existing CCU session.
 *
 * The shared session logs in once, replaces a refused session once per call
 * and logs out every session it gives up. On top of that this reader keeps
 * the gas meter's own backoff: a rejected login, or a session that logs in
 * fine but whose call is refused again (usually missing rights), counts as
 * a failure; the next attempt waits one poll interval, then doubling waits
 * up to MAX_AUTH_BACKOFF_MS. Only a successful data call ends the backoff.
 * While it runs, the gas meter sends nothing to the CCU.
 *
 * Error texts are masked: the CCU host, the device address, the CCU user and
 * any IPv4 address never reach the log or the API.
 */
export class GasCcuReader {
    session;
    opts;
    failures = 0;
    blockedUntil = 0;
    /** Told whenever the backoff changes, so the caller can keep it across restarts. */
    onAuthState;
    constructor(session, opts) {
        this.session = session;
        this.opts = opts;
    }
    now() {
        return (this.opts.now ?? Date.now)();
    }
    /** Continue the backoff from before a restart, so a restart loop cannot multiply logins. */
    restoreAuthState(saved) {
        if (!Number.isInteger(saved.failures) || saved.failures <= 0)
            return;
        this.failures = Math.min(saved.failures, 64);
        // Never trust a far-future block from a file: at most one maximum backoff from now.
        this.blockedUntil = Math.min(saved.blockedUntil, this.now() + MAX_AUTH_BACKOFF_MS);
    }
    get authState() {
        return { failures: this.failures, blockedUntil: this.blockedUntil };
    }
    get hasSession() {
        return this.session.hasSession;
    }
    /** When the next attempt may be made after failures, else undefined. */
    get retryAt() {
        return this.blockedUntil > this.now() ? this.blockedUntil : undefined;
    }
    /** A CCU text safe to log and serve: masked, printable ASCII, at most 120 characters. */
    clean(text) {
        let s = text;
        const secrets = this.opts.redact
            .map((x) => x.trim())
            .filter((x) => x.length > 0)
            .sort((a, b) => b.length - a.length);
        for (const secret of secrets) {
            s = s.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '***');
        }
        s = s.replace(IPV4, '***');
        return s.replace(/[^\x20-\x7e]/g, ' ').slice(0, MAX_MESSAGE);
    }
    failAuth(message) {
        this.failures += 1;
        const wait = Math.min(MAX_AUTH_BACKOFF_MS, this.opts.authBackoffMs * 2 ** Math.max(0, this.failures - 1));
        this.blockedUntil = this.now() + wait;
        this.onAuthState?.(this.authState);
        return new GasCcuError('auth', message);
    }
    succeeded() {
        if (this.failures === 0 && this.blockedUntil === 0)
            return;
        this.failures = 0;
        this.blockedUntil = 0;
        this.onAuthState?.(this.authState);
    }
    async call(method, params) {
        assertAllowed(method, params);
        if (this.blockedUntil > this.now()) {
            throw new GasCcuError('auth', 'CCU access paused after a rejected login or refused session');
        }
        let result;
        try {
            result = await this.session.call(method, params);
        }
        catch (err) {
            const message = this.clean(err instanceof Error ? err.message : String(err));
            if (err instanceof JsonRpcError && (err.kind === 'auth' || err.kind === 'session')) {
                throw this.failAuth(err.kind === 'auth'
                    ? `CCU login rejected: ${message}`
                    : `CCU refused a fresh session (check the rights of the CCU user): ${message}`);
            }
            throw new GasCcuError(err instanceof JsonRpcError && err.kind === 'network' ? 'network' : 'protocol', message);
        }
        this.succeeded();
        return result;
    }
    /** `Interface.getParamset` of the `VALUES` paramset of one channel. */
    async getValues(iface, address) {
        const result = await this.call('Interface.getParamset', { interface: iface, address, paramsetKey: 'VALUES' });
        if (result === null || typeof result !== 'object' || Array.isArray(result)) {
            throw new GasCcuError('protocol', 'CCU sent no paramset');
        }
        return result;
    }
    /** `Interface.getValue` of one datapoint. */
    getValue(iface, address, valueKey) {
        return this.call('Interface.getValue', { interface: iface, address, valueKey });
    }
    /** `Interface.getParamsetDescription` of the `VALUES` paramset of one channel. */
    describeValues(iface, address) {
        return this.call('Interface.getParamsetDescription', { interface: iface, address, paramsetType: 'VALUES' });
    }
}
/** A CCU number: a finite number or a numeric string; anything else is undefined. */
export function ccuNumber(v) {
    if (typeof v === 'number')
        return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?([eE][+-]?\d+)?\s*$/.test(v)) {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}
/** A CCU boolean: true/false, "true"/"false", 1/0 or "1"/"0"; anything else is undefined. */
export function ccuBool(v) {
    if (v === true || v === 1 || v === '1' || v === 'true')
        return true;
    if (v === false || v === 0 || v === '0' || v === 'false')
        return false;
    return undefined;
}
//# sourceMappingURL=ccuReader.js.map
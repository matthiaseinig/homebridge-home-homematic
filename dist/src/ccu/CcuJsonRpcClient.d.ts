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
import { type Agent as HttpsAgent } from 'node:https';
import type { PrefixedLogger } from '../util/logger.js';
import type { CcuDevice, CcuProgram, CcuVariable } from '../types.js';
/** A method refused even with a fresh session waits this long, doubling up to the maximum. */
export declare const PERMISSION_BACKOFF_MS: number;
export declare const MAX_PERMISSION_BACKOFF_MS: number;
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
    auth?: {
        username: string;
        password: string;
    };
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
export declare class JsonRpcError extends Error {
    readonly code?: number | undefined;
    readonly cause?: unknown | undefined;
    readonly kind: JsonRpcErrorKind;
    constructor(message: string, code?: number | undefined, cause?: unknown | undefined, kind?: JsonRpcErrorKind);
}
/** Raw API surface — exposed for callers that need methods we don't wrap yet. */
export declare class CcuJsonRpcClient {
    private readonly host;
    private readonly useTls;
    private readonly portOverride;
    private readonly timeoutMs;
    private readonly tlsAgent;
    private readonly auth?;
    private readonly log;
    private session;
    private loginInFlight;
    private seq;
    private readonly denied;
    private readonly now;
    constructor(opts: CcuJsonRpcOptions);
    /** Drop the cached session (it is logged out once its requests are done); the next call logs in again. */
    invalidateSession(): void;
    /** True while a session is cached. */
    get hasSession(): boolean;
    /**
     * Log the cached session out (best effort) and forget it. Used on
     * shutdown, so no session is left open on the CCU until its timeout.
     */
    logout(): Promise<void>;
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
    call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
    private callOnce;
    /** Put a method refused with a valid session on its backoff; warn once per method. */
    private denyMethod;
    /** Stop handing `s` out; it is logged out (once) as soon as no request uses it. */
    private retire;
    /** Log out a replaced session that no request uses any more. Exactly once per session. */
    private drain;
    /** Mask the password and session ids in a CCU error text, which may echo the request. */
    private scrub;
    private ensureSession;
    private login;
    /**
     * One-shot CCU device tree: every device with its channels embedded.
     * Maps RaspberryMatic's `Device.listAllDetail` into our internal shape.
     */
    listDevices(): Promise<CcuDevice[]>;
    listVariables(): Promise<CcuVariable[]>;
    listPrograms(): Promise<CcuProgram[]>;
    listRooms(): Promise<{
        id: string;
        name: string;
        channelIds: string[];
    }[]>;
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
    listInterfaces(): Promise<Array<{
        name: string;
        port: number;
        url?: string;
    }>>;
    getInterfaceValue(interfaceName: string, address: string, valueKey: string): Promise<string>;
    setInterfaceValue(interfaceName: string, address: string, valueKey: string, type: 'boolean' | 'string' | 'integer' | 'double', value: unknown): Promise<void>;
    getVariable(name: string): Promise<string>;
    setVariable(name: string, value: string | number | boolean): Promise<void>;
    runProgram(name: string): Promise<void>;
    private postJson;
}
export declare function isSafeIdentifier(value: unknown): value is string;

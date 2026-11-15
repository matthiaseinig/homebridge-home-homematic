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
import type { PrefixedLogger } from '../util/logger.js';
import type { CcuDevice, CcuProgram, CcuVariable } from '../types.js';
export interface CcuJsonRpcOptions {
    host: string;
    useTls?: boolean;
    /** Override the default 80/443 API port (mainly for tests). */
    port?: number;
    timeoutMs?: number;
    auth?: {
        username: string;
        password: string;
    };
    log: PrefixedLogger;
}
/**
 * What went wrong: `auth` the login was rejected, `session` the CCU refused
 * the call for its session (also with a fresh one, usually missing rights),
 * `protocol` the CCU answered with another error or no JSON, `network` no
 * usable HTTP answer.
 */
export type JsonRpcErrorKind = 'auth' | 'session' | 'protocol' | 'network';
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
    private readonly auth?;
    private readonly log;
    private sessionId;
    private loginInFlight;
    constructor(opts: CcuJsonRpcOptions);
    /** Drop the cached session id; the next authenticated call will re-login. */
    invalidateSession(): void;
    /** True while a session id is cached. */
    get hasSession(): boolean;
    /**
     * Log the cached session out (best effort) and forget it. Used on
     * shutdown, so no session is left open on the CCU until its timeout.
     */
    logout(): Promise<void>;
    /**
     * Invoke a JSON-RPC method, automatically attaching `_session_id_` if
     * authentication is configured. When the CCU refuses the session, it is
     * logged out and replaced once and the call is retried; when the fresh
     * session is refused too, that one is logged out as well and the call
     * fails with kind `session`. Every session this client gives up is logged
     * out, so none is left open on the CCU.
     */
    call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
    private callOnce;
    /** Forget `sid` if it is still the cached one and log it out (best effort). Exactly one caller does this per session. */
    private abandon;
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

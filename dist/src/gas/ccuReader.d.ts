/**
 * The only JSON-RPC methods the gas meter ever sends, through the plugin's
 * shared CCU session. Every request goes through `assertAllowed`: there is
 * no setter, script, program or system variable call for this device, and
 * the paramset methods are limited to `VALUES`. (`Session.login` and
 * `Session.logout` are sent by the shared session itself.)
 */
export declare const GAS_CCU_METHODS: readonly ["Interface.getValue", "Interface.getParamset", "Interface.getParamsetDescription"];
export type GasCcuMethod = (typeof GAS_CCU_METHODS)[number];
/** Longest wait between attempts after rejected logins or refused sessions. */
export declare const MAX_AUTH_BACKOFF_MS: number;
export type GasCcuErrorKind = 'auth' | 'protocol' | 'network' | 'refused';
export declare class GasCcuError extends Error {
    readonly kind: GasCcuErrorKind;
    constructor(kind: GasCcuErrorKind, message: string);
}
/** Throws unless `method` is on the allow-list and a paramset call asks for `VALUES`. */
export declare function assertAllowed(method: string, params: Record<string, unknown>): void;
/** Failed attempts so far and when the next may be tried; kept across restarts by the caller. */
export interface AuthState {
    failures: number;
    blockedUntil: number;
}
/** The part of the shared CCU JSON-RPC client the gas meter uses. */
export interface SharedCcuSession {
    call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
    readonly hasSession: boolean;
}
export interface GasCcuReaderOptions {
    /** First wait after a rejected login or refused session; doubles per failure up to MAX_AUTH_BACKOFF_MS. */
    authBackoffMs: number;
    now?: () => number;
    /** Strings masked in every CCU error text: the CCU host, the device address, the CCU user. */
    redact: readonly string[];
}
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
export declare class GasCcuReader {
    private readonly session;
    private readonly opts;
    private failures;
    private blockedUntil;
    /** Told whenever the backoff changes, so the caller can keep it across restarts. */
    onAuthState: ((state: AuthState) => void) | undefined;
    constructor(session: SharedCcuSession, opts: GasCcuReaderOptions);
    private now;
    /** Continue the backoff from before a restart, so a restart loop cannot multiply logins. */
    restoreAuthState(saved: AuthState): void;
    get authState(): AuthState;
    get hasSession(): boolean;
    /** When the next attempt may be made after failures, else undefined. */
    get retryAt(): number | undefined;
    /** A CCU text safe to log and serve: masked, printable ASCII, at most 120 characters. */
    clean(text: string): string;
    private failAuth;
    private succeeded;
    private call;
    /** `Interface.getParamset` of the `VALUES` paramset of one channel. */
    getValues(iface: string, address: string): Promise<Record<string, unknown>>;
    /** `Interface.getValue` of one datapoint. */
    getValue(iface: string, address: string, valueKey: string): Promise<unknown>;
    /** `Interface.getParamsetDescription` of the `VALUES` paramset of one channel. */
    describeValues(iface: string, address: string): Promise<unknown>;
}
/** A CCU number: a finite number or a numeric string; anything else is undefined. */
export declare function ccuNumber(v: unknown): number | undefined;
/** A CCU boolean: true/false, "true"/"false", 1/0 or "1"/"0"; anything else is undefined. */
export declare function ccuBool(v: unknown): boolean | undefined;

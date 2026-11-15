import type { RouteResult } from './route.js';
export interface GasApiServerOptions {
    bindAddress: string;
    port: number;
    /** Required: the API is never served without a token. */
    token: string;
    /** The `/v1/gas/*` routes. */
    handle: (url: URL, nowMs: number) => Promise<RouteResult>;
    /** Receives the one-time warning when /v1/hello is off because the token is weak. */
    warn?: (message: string) => void;
    now?: () => number;
}
/**
 * Minimal read-only JSON API of the gas meter (the pattern of the energy
 * plugin's history API). GET only. It binds to one literal private or
 * loopback address (never a wildcard), refuses requests from non-private
 * peers, accepts only `Host: <bindAddress>:<port>` (421 otherwise, which
 * stops DNS rebinding) and always requires `Authorization: Bearer <token>`,
 * except GET /v1/hello.
 *
 *   GET /v1/hello?nonce=<43 base64url>   (no token: HMAC proof in X-Home-Proof, 30 per minute per peer)
 *   GET /v1/gas/status | live?date | days?from&to | months?from&to | years?from&to
 */
export declare class GasApiServer {
    private readonly opts;
    private server;
    private allowedHost;
    private readonly helloLimiter;
    private readonly helloEnabled;
    constructor(opts: GasApiServerOptions);
    /** Resolves with the bound port (useful with port 0 in tests). */
    start(): Promise<number>;
    stop(): Promise<void>;
    private now;
    private send;
    private handle;
    /** Token-free proof of the real service; the only route without `Authorization`. */
    private hello;
}

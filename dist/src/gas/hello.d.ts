/** Token-free proof route: the app checks it reaches the real home service before it sends its bearer token. */
export declare const HELLO_PATH = "/v1/hello";
export declare const HELLO_LIMIT_PER_MINUTE = 30;
export declare const MAX_TRACKED_PEERS = 256;
export declare const HELLO_OFF_WARNING: string;
/**
 * The route is an unauthenticated oracle (a proof lets one test token guesses offline), so it is served only
 * for a token that cannot be guessed: at least 32 characters, hex or base64 characters (so at least 128 bits
 * when random), at least 10 distinct characters and no run of more than 4 equal characters.
 */
export declare function isHelloTokenStrong(token: string): boolean;
/** `base64url_nopad(HMAC-SHA256(key = token, msg = "HOME-HELLO\n" + nonce + "\n" + host))`. */
export declare function helloProof(token: string, nonce: string, host: string): string;
/** Fixed-window request counter per peer address. */
export declare class HelloRateLimiter {
    private readonly limit;
    private readonly windows;
    constructor(limit?: number);
    /** True when the request is within the limit; counts it either way. */
    allow(peer: string, nowMs: number): boolean;
    /** Number of tracked peers (for tests). */
    get size(): number;
}
export type HelloResult = {
    status: 204;
    proof: string;
} | {
    status: 400 | 429;
    error: string;
};
/** The answer of GET /v1/hello. `searchParams` is the parsed query; the nonce is used exactly as received. */
export declare function handleHello(searchParams: URLSearchParams, token: string, host: string, limiter: HelloRateLimiter, peer: string, nowMs: number): HelloResult;

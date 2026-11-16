/**
 * Static listener for the "large view" settings page (issue Home#614).
 *
 * Runs inside the custom UI server child that homebridge-config-ui-x forks
 * while the plugin settings dialog is open, and only there. It serves a few
 * static files and nothing else: no API, no config, no credentials. All data
 * reaches the page by postMessage from the dialog iframe that opened it.
 *
 * Hardening:
 *  - binds to exactly one private or loopback address of this host: the one
 *    the dialog iframe was loaded from (never a wildcard);
 *  - accepts only `Host: <that host>:<port>` (421 otherwise; stops DNS
 *    rebinding) and only private peers;
 *  - GET and HEAD only, fixed file allowlist, no path from the URL reaches
 *    the file system;
 *  - `frame-ancestors 'none'` plus `X-Frame-Options: DENY`, `connect-src
 *    'none'`. No COOP header: it would sever window.opener, which the page
 *    needs to talk to the dialog.
 */
export declare class LargeViewError extends Error {
}
export interface LargeViewAsset {
    /** Absolute path of the file on disk. */
    file: string;
    contentType: string;
}
export interface LargeViewDeps {
    /** Resolves a host name to its addresses (default: dns.lookup with all: true). */
    lookup?: (hostname: string) => Promise<string[]>;
    /** Addresses of this host's interfaces (default: os.networkInterfaces). */
    localAddresses?: () => string[];
}
export interface LargeViewServerOptions extends LargeViewDeps {
    /** `location.origin` of the dialog iframe, for example `http://10.0.0.5:8581`. */
    openerOrigin: string;
    /** Template for `/` and `/index.html`; `%%OPENER_ORIGIN%%` is replaced with the (escaped) opener origin. */
    indexFile: string;
    /** URL path (for example `/page.js`) to file. */
    assets: Record<string, LargeViewAsset>;
}
export interface LargeViewBind {
    /** Host as it appears in a URL and in the Host header (IPv6 in brackets). */
    urlHost: string;
    /** Literal address the listener binds to. */
    bindAddress: string;
}
export interface LargeViewStarted {
    url: string;
    pageOrigin: string;
    port: number;
}
export declare const LARGE_VIEW_HEADERS: Readonly<Record<string, string>>;
/** Parses and checks the opener origin; returns its URL. */
export declare function parseOpenerOrigin(origin: unknown): URL;
/**
 * Finds the one address to bind to: the iframe's host when it is a literal
 * private address of this host, or the first private local address the host
 * name resolves to.
 */
export declare function resolveLargeViewBind(openerOrigin: string, deps?: LargeViewDeps): Promise<LargeViewBind>;
export declare class LargeViewServer {
    private readonly opts;
    readonly bind: LargeViewBind;
    private server;
    private allowedHost;
    private files;
    private constructor();
    static create(opts: LargeViewServerOptions): Promise<LargeViewServer>;
    get openerOrigin(): string;
    get running(): boolean;
    start(): Promise<LargeViewStarted>;
    stop(): Promise<void>;
    private loadFiles;
    private reply;
    private handle;
}

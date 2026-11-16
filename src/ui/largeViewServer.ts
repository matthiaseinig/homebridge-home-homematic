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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { isPrivateAddress } from '../gas/net.js';

export class LargeViewError extends Error {}

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

const ORIGIN_OPENER_PLACEHOLDER = '%%OPENER_ORIGIN%%';

export const LARGE_VIEW_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

function defaultLocalAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .map((i) => i.address);
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const res = await dnsLookup(hostname, { all: true });
  return res.map((r) => r.address);
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Parses and checks the opener origin; returns its URL. */
export function parseOpenerOrigin(origin: unknown): URL {
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > 300) {
    throw new LargeViewError('missing or invalid origin');
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new LargeViewError('invalid origin');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LargeViewError('origin must be http or https');
  }
  if (url.origin !== origin) {
    throw new LargeViewError('origin must be a bare origin (scheme, host, port)');
  }
  return url;
}

/**
 * Finds the one address to bind to: the iframe's host when it is a literal
 * private address of this host, or the first private local address the host
 * name resolves to.
 */
export async function resolveLargeViewBind(openerOrigin: string, deps: LargeViewDeps = {}): Promise<LargeViewBind> {
  const url = parseOpenerOrigin(openerOrigin);
  const urlHost = url.hostname.toLowerCase();
  const host = stripBrackets(urlHost);
  const local = new Set((deps.localAddresses ?? defaultLocalAddresses)().map((a) => a.toLowerCase()));
  const candidates = isIP(host) ? [host] : await (deps.lookup ?? defaultLookup)(host).catch(() => []);
  const bindAddress = candidates
    .map((a) => a.toLowerCase())
    .find((a) => isPrivateAddress(a) && local.has(a));
  if (!bindAddress) {
    throw new LargeViewError(
      `the large view needs Homebridge UI opened on a private address of this host (got ${host})`,
    );
  }
  return { urlHost, bindAddress };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

interface LoadedAsset {
  body: Buffer;
  contentType: string;
}

export class LargeViewServer {
  private server: Server | null = null;
  private allowedHost = '';
  private files = new Map<string, LoadedAsset>();

  private constructor(
    private readonly opts: LargeViewServerOptions,
    readonly bind: LargeViewBind,
  ) {}

  static async create(opts: LargeViewServerOptions): Promise<LargeViewServer> {
    const bind = await resolveLargeViewBind(opts.openerOrigin, opts);
    return new LargeViewServer(opts, bind);
  }

  get openerOrigin(): string {
    return this.opts.openerOrigin;
  }

  get running(): boolean {
    return this.server !== null;
  }

  async start(): Promise<LargeViewStarted> {
    if (this.server) throw new LargeViewError('already running');
    await this.loadFiles();
    const server = createServer((req, res) => this.handle(req, res));
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, this.bind.bindAddress, () => {
        server.off('error', reject);
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    this.server = server;
    this.allowedHost = `${this.bind.urlHost}:${port}`;
    const pageOrigin = `http://${this.allowedHost}`;
    return { url: `${pageOrigin}/`, pageOrigin, port };
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async loadFiles(): Promise<void> {
    const files = new Map<string, LoadedAsset>();
    const template = await readFile(this.opts.indexFile, 'utf8');
    const index = Buffer.from(template.split(ORIGIN_OPENER_PLACEHOLDER).join(escapeHtml(this.opts.openerOrigin)));
    const html = { body: index, contentType: 'text/html; charset=utf-8' };
    files.set('/', html);
    files.set('/index.html', html);
    for (const [path, asset] of Object.entries(this.opts.assets)) {
      files.set(path, { body: await readFile(asset.file), contentType: asset.contentType });
    }
    this.files = files;
  }

  private reply(res: ServerResponse, status: number, body: Buffer | string, contentType: string, head: boolean): void {
    res.writeHead(status, { ...LARGE_VIEW_HEADERS, 'Content-Type': contentType });
    res.end(head ? undefined : body);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const text = 'text/plain; charset=utf-8';
    const head = req.method === 'HEAD';
    if (!isPrivateAddress(req.socket.remoteAddress ?? '')) return this.reply(res, 403, 'forbidden', text, head);
    if ((req.headers.host ?? '').toLowerCase() !== this.allowedHost) {
      return this.reply(res, 421, 'misdirected request', text, head);
    }
    if (req.method !== 'GET' && !head) {
      res.setHeader('Allow', 'GET, HEAD');
      return this.reply(res, 405, 'method not allowed', text, false);
    }
    const path = (req.url ?? '/').split('?')[0]!;
    const file = this.files.get(path);
    if (!file) return this.reply(res, 404, 'not found', text, head);
    return this.reply(res, 200, file.body, file.contentType, head);
  }
}

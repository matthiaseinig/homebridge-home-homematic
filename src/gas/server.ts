import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { HELLO_OFF_WARNING, HELLO_PATH, HelloRateLimiter, handleHello, isHelloTokenStrong } from './hello.js';
import { isPrivateAddress } from './net.js';
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

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
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
export class GasApiServer {
  private server: Server | null = null;
  private allowedHost = '';
  private readonly helloLimiter = new HelloRateLimiter();
  private readonly helloEnabled: boolean;

  constructor(private readonly opts: GasApiServerOptions) {
    if (!isPrivateAddress(opts.bindAddress)) {
      throw new Error('the gas API must bind to a private or loopback address');
    }
    if (!opts.token) throw new Error('the gas API needs a token');
    this.helloEnabled = isHelloTokenStrong(opts.token);
    if (!this.helloEnabled) opts.warn?.(HELLO_OFF_WARNING);
  }

  /** Resolves with the bound port (useful with port 0 in tests). */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.bindAddress, () => {
        server.off('error', reject);
        this.server = server;
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : this.opts.port;
        const host = this.opts.bindAddress.includes(':') ? `[${this.opts.bindAddress}]` : this.opts.bindAddress;
        this.allowedHost = `${host}:${port}`.toLowerCase();
        resolve(port);
      });
    });
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

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!isPrivateAddress(req.socket.remoteAddress ?? '')) return this.send(res, 403, { error: 'forbidden' });
      if ((req.headers.host ?? '').toLowerCase() !== this.allowedHost) {
        return this.send(res, 421, { error: 'misdirected request' });
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === HELLO_PATH) return this.hello(req, res, url);
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return this.send(res, 405, { error: 'method not allowed' });
      }
      const header = req.headers.authorization ?? '';
      if (!header.startsWith('Bearer ') || !safeEqual(header.slice(7), this.opts.token)) {
        return this.send(res, 401, { error: 'unauthorized' });
      }
      if (!url.pathname.startsWith('/v1/gas/')) return this.send(res, 404, { error: 'not found' });
      const r = await this.opts.handle(url, this.now());
      return this.send(res, r.status, r.body);
    } catch {
      this.send(res, 500, { error: 'internal error' });
    }
  }

  /** Token-free proof of the real service; the only route without `Authorization`. */
  private hello(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (!this.helloEnabled) return this.send(res, 404, { error: 'not found' });
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return this.send(res, 405, { error: 'method not allowed' });
    }
    const r = handleHello(
      url.searchParams,
      this.opts.token,
      this.allowedHost,
      this.helloLimiter,
      req.socket.remoteAddress ?? '',
      this.now(),
    );
    if (r.status !== 204) {
      if (r.status === 429) res.setHeader('Retry-After', '60');
      return this.send(res, r.status, { error: r.error });
    }
    res.writeHead(204, {
      'X-Home-Proof': r.proof,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end();
  }
}

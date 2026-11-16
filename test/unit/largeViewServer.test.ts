import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LargeViewServer, LargeViewError, parseOpenerOrigin, resolveLargeViewBind } from '../../src/ui/largeViewServer.js';
import { LargeViewController } from '../../src/ui/largeViewController.js';

let dir = '';
let indexFile = '';
let assets: Record<string, { file: string; contentType: string }> = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hm-largeview-test-'));
  indexFile = join(dir, 'index.html');
  writeFileSync(indexFile, '<meta name="hm-opener-origin" content="%%OPENER_ORIGIN%%">');
  writeFileSync(join(dir, 'page.js'), 'export {};');
  assets = { '/page.js': { file: join(dir, 'page.js'), contentType: 'text/javascript; charset=utf-8' } };
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const LOOPBACK = { localAddresses: () => ['127.0.0.1', '::1', '10.0.0.5'] };

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function get(port: number, path: string, opts: { host?: string; method?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { Host: opts.host ?? `127.0.0.1:${port}` }, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

const servers: LargeViewServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function startServer(openerOrigin = 'http://127.0.0.1:8581') {
  const s = await LargeViewServer.create({ openerOrigin, indexFile, assets, ...LOOPBACK });
  servers.push(s);
  return { server: s, started: await s.start() };
}

describe('large view: bind address', () => {
  it('binds to the literal private address the dialog was loaded from', async () => {
    expect(await resolveLargeViewBind('http://10.0.0.5:8581', LOOPBACK)).toEqual({ urlHost: '10.0.0.5', bindAddress: '10.0.0.5' });
    expect(await resolveLargeViewBind('https://[::1]:8581', LOOPBACK)).toEqual({ urlHost: '[::1]', bindAddress: '::1' });
  });

  it('uses the real interfaces and DNS by default (loopback)', async () => {
    expect(await resolveLargeViewBind('http://127.0.0.1:8581')).toEqual({ urlHost: '127.0.0.1', bindAddress: '127.0.0.1' });
    const r = await resolveLargeViewBind('http://localhost:8581');
    expect(r.urlHost).toBe('localhost');
    expect(['127.0.0.1', '::1']).toContain(r.bindAddress);
  });

  it('resolves a host name to a private address of this host', async () => {
    const lookup = vi.fn(async () => ['192.0.2.10', '10.0.0.5']);
    expect(await resolveLargeViewBind('http://homebridge.local:8581', { ...LOOPBACK, lookup })).toEqual({ urlHost: 'homebridge.local', bindAddress: '10.0.0.5' });
  });

  it.each([
    ['public address', 'http://8.8.8.8:8581'],
    ['private but not this host', 'http://10.0.0.99:8581'],
    ['wildcard', 'http://0.0.0.0:8581'],
  ])('refuses a %s', async (_l, origin) => {
    await expect(resolveLargeViewBind(origin, LOOPBACK)).rejects.toBeInstanceOf(LargeViewError);
  });

  it('refuses a name that does not resolve to this host', async () => {
    await expect(resolveLargeViewBind('http://evil.example:8581', { ...LOOPBACK, lookup: async () => ['10.0.0.99'] }))
      .rejects.toBeInstanceOf(LargeViewError);
    await expect(resolveLargeViewBind('http://nx.example:8581', { ...LOOPBACK, lookup: async () => { throw new Error('ENOTFOUND'); } }))
      .rejects.toBeInstanceOf(LargeViewError);
  });

  it.each([undefined, '', 'not a url', 'ftp://10.0.0.5', 'http://10.0.0.5:8581/path', 'http://u:p@10.0.0.5:8581', 'x'.repeat(400)])(
    'refuses origin %s', (origin) => {
      expect(() => parseOpenerOrigin(origin)).toThrow(LargeViewError);
    },
  );
});

describe('large view: listener', () => {
  it('serves the page with the opener origin and strict headers', async () => {
    const { started } = await startServer();
    expect(started.url).toBe(`http://127.0.0.1:${started.port}/`);
    expect(started.pageOrigin).toBe(`http://127.0.0.1:${started.port}`);
    const res = await get(started.port, '/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('content="http://127.0.0.1:8581"');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cross-origin-opener-policy']).toBeUndefined();
    expect((await get(started.port, '/page.js')).headers['content-type']).toContain('javascript');
  });

  it('escapes the opener origin in the HTML', async () => {
    // A valid origin cannot contain quotes; the escape is defence in depth.
    const s = await LargeViewServer.create({ openerOrigin: 'http://127.0.0.1:8581', indexFile, assets, ...LOOPBACK });
    servers.push(s);
    const { port } = await s.start();
    expect((await get(port, '/index.html')).body).not.toContain('%%OPENER_ORIGIN%%');
  });

  it('rejects a foreign Host header with 421 (DNS rebinding)', async () => {
    const { started } = await startServer();
    expect((await get(started.port, '/', { host: `evil.example:${started.port}` })).status).toBe(421);
    expect((await get(started.port, '/', { host: '127.0.0.1' })).status).toBe(421);
    expect((await get(started.port, '/', { host: `127.0.0.1:${started.port + 1}` })).status).toBe(421);
  });

  it('serves only GET/HEAD and only the allowlisted files', async () => {
    const { started } = await startServer();
    const post = await get(started.port, '/', { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
    expect((await get(started.port, '/../index.html')).status).toBe(404);
    expect((await get(started.port, '/server.js')).status).toBe(404);
    expect((await get(started.port, '/page.js?x=1')).status).toBe(200);
    const head = await get(started.port, '/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it('frees the port on stop, and stop is idempotent', async () => {
    const { server, started } = await startServer();
    expect(await portIsFree(started.port)).toBe(false);
    await server.stop();
    await server.stop();
    expect(server.running).toBe(false);
    expect(await portIsFree(started.port)).toBe(true);
  });

  it('refuses a second start', async () => {
    const { server } = await startServer();
    await expect(server.start()).rejects.toBeInstanceOf(LargeViewError);
  });
});

describe('large view: controller and shutdown', () => {
  const make = () => new LargeViewController({ indexFile, assets, ...LOOPBACK });

  it('reuses the listener for the same dialog and restarts for another origin', async () => {
    const c = make();
    const a = await c.info({ origin: 'http://127.0.0.1:8581' });
    const b = await c.info({ origin: 'http://127.0.0.1:8581' });
    expect(b.port).toBe(a.port);
    expect(a.openerOrigin).toBe('http://127.0.0.1:8581');
    const d = await c.info({ origin: 'http://127.0.0.1:9000' });
    expect(d.port).not.toBe(a.port);
    expect(await portIsFree(a.port)).toBe(true);
    expect(await c.stop()).toEqual({ stopped: true });
    expect(await c.stop()).toEqual({ stopped: false });
    expect(await portIsFree(d.port)).toBe(true);
  });

  it('starts only one listener for concurrent requests', async () => {
    const c = make();
    const [a, b] = await Promise.all([c.info({ origin: 'http://127.0.0.1:8581' }), c.info({ origin: 'http://127.0.0.1:8581' })]);
    expect(a.port).toBe(b.port);
    await c.stop();
  });

  it('rejects a missing or bad origin before touching the network', async () => {
    const c = make();
    expect(() => c.info({})).toThrow(LargeViewError);
    expect(() => c.info(null)).toThrow(LargeViewError);
    await expect(c.info({ origin: 'http://8.8.8.8:8581' })).rejects.toBeInstanceOf(LargeViewError);
    expect(c.running).toBe(false);
  });

  it('closes the listener and exits on SIGTERM (dialog closed)', async () => {
    const c = make();
    const proc = new EventEmitter();
    const exit = vi.fn();
    c.installShutdownHooks(proc as any, exit);
    const { port } = await c.info({ origin: 'http://127.0.0.1:8581' });
    proc.emit('SIGTERM');
    proc.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(c.running).toBe(false);
    expect(await portIsFree(port)).toBe(true);
  });

  it('closes the listener when the IPC channel disconnects', async () => {
    const c = make();
    const proc = new EventEmitter();
    c.installShutdownHooks(proc as any, vi.fn());
    const { port } = await c.info({ origin: 'http://127.0.0.1:8581' });
    proc.emit('disconnect');
    await vi.waitFor(async () => expect(await portIsFree(port)).toBe(true));
  });

  it('exits after the grace period even if stopping hangs', async () => {
    vi.useFakeTimers();
    try {
      const c = make();
      vi.spyOn(c, 'stop').mockReturnValue(new Promise(() => undefined));
      const proc = new EventEmitter();
      const exit = vi.fn();
      c.installShutdownHooks(proc as any, exit, 50);
      proc.emit('SIGTERM');
      await vi.advanceTimersByTimeAsync(60);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

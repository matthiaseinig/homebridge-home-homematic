/**
 * TLS XML-RPC to the CCU: a local HTTPS server with a throwaway self-signed
 * certificate (generated with openssl per run) stands in for the CCU's TLS
 * ports. Credentials must only ever reach it inside an accepted TLS session.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { ccuTlsAgent, normalizeFingerprint, refusesCredentials, TLS_CREDENTIALS_REFUSED, TLS_INTERFACE_PORTS } from '../../src/ccu/ccuTls.js';
import { CcuJsonRpcClient } from '../../src/ccu/CcuJsonRpcClient.js';
import { RpcClient, basicAuthHeader } from '../../src/ccu/RpcClient.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';

const AUTH = { username: 'hb-test', password: 'not-a-real-secret' };
const OK_XML = '<?xml version="1.0"?><methodResponse><params><param><value></value></param></params></methodResponse>';
const OTHER_FP = Array.from({ length: 32 }, () => 'AB').join(':');

function haveOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('normalizeFingerprint', () => {
  it('accepts colon, space and lower-case forms and rejects anything else', () => {
    const hex = 'ab'.repeat(32);
    expect(normalizeFingerprint(hex)).toBe(OTHER_FP);
    expect(normalizeFingerprint(OTHER_FP.toLowerCase())).toBe(OTHER_FP);
    expect(normalizeFingerprint(` ${OTHER_FP.replace(/:/g, ' ')} `)).toBe(OTHER_FP);
    expect(normalizeFingerprint('ab'.repeat(31))).toBeUndefined();
    expect(normalizeFingerprint('zz'.repeat(32))).toBeUndefined();
  });

  it('lists the CCU TLS XML-RPC ports, none for CUxD', () => {
    expect(TLS_INTERFACE_PORTS).toEqual({ 'BidCos-RF': 42001, 'HmIP-RF': 42010, 'BidCos-Wired': 42000, 'VirtualDevices': 49292 });
  });

  it('verifies certificates unless self-signed is explicitly allowed', () => {
    expect(ccuTlsAgent({ allowSelfSigned: false }).options.rejectUnauthorized).toBe(true);
    expect(ccuTlsAgent({ allowSelfSigned: true }).options.rejectUnauthorized).toBe(false);
    expect(ccuTlsAgent({ allowSelfSigned: true }, true).options.rejectUnauthorized).toBe(false);
  });

  it('refuses credentials only when neither a pin nor tlsAllowSelfSigned is set', () => {
    expect(refusesCredentials({ allowSelfSigned: false }, true)).toBe(true);
    expect(refusesCredentials({ allowSelfSigned: false }, false)).toBe(false);
    expect(refusesCredentials({ allowSelfSigned: true }, true)).toBe(false);
    expect(refusesCredentials({ allowSelfSigned: false, fingerprint256: OTHER_FP }, true)).toBe(false);
  });

  it('the refusing agent fails a request before any socket is opened', async () => {
    const err = await new Promise<Error>((resolve) => {
      const req = https.request({ host: '192.0.2.1', port: 443, method: 'POST', agent: ccuTlsAgent({ allowSelfSigned: false }, true) });
      req.on('error', resolve);
      req.on('socket', () => resolve(new Error('a socket was opened')));
      req.end('{}');
    });
    expect(err.message).toBe(TLS_CREDENTIALS_REFUSED);
  });
});

describe.skipIf(!haveOpenssl())('RpcClient over TLS against a self-signed CCU', () => {
  let dir = '';
  let key: Buffer;
  let cert: Buffer;
  let fingerprint = '';
  let server: https.Server | undefined;
  let raw: tls.Server | undefined;
  let requests: Array<{ authorization?: string }> = [];

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmhap-tls-test-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'),
      '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
    key = fs.readFileSync(path.join(dir, 'k.pem'));
    cert = fs.readFileSync(path.join(dir, 'c.pem'));
    fingerprint = new X509Certificate(cert).fingerprint256;
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterEach(async () => {
    for (const s of [server, raw]) {
      if (s) {
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
    }
    server = undefined;
    raw = undefined;
  });

  async function ccu(): Promise<number> {
    requests = [];
    server = https.createServer({ key, cert }, (req, res) => {
      requests.push({ authorization: req.headers.authorization });
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/xml', Connection: 'close' });
        res.end(OK_XML);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    return (server.address() as { port: number }).port;
  }

  function client(port: number, opts: { tls: { allowSelfSigned: boolean; fingerprint256?: string }; auth?: typeof AUTH }): RpcClient {
    return new RpcClient({
      interfaceId: 'HmIP-RF',
      host: '127.0.0.1',
      port,
      callbackUrl: 'http://192.0.2.10:9875',
      callbackId: 'cb-tls',
      auth: opts.auth,
      tls: opts.tls,
      log: new PrefixedLogger(makeLog(), 'rpc-tls'),
    });
  }

  it('a pinned certificate is accepted and the credentials arrive inside TLS', async () => {
    const port = await ccu();
    await client(port, { tls: { allowSelfSigned: false, fingerprint256: fingerprint }, auth: AUTH }).subscribe();
    expect(requests).toEqual([{ authorization: basicAuthHeader(AUTH) }]);
  });

  it('a different certificate is refused before any request byte is sent', async () => {
    let tcp = 0;
    const plaintext: number[] = [];
    raw = tls.createServer({ key, cert }, (s) => {
      s.on('data', (d: Buffer) => plaintext.push(d.length));
      s.on('error', () => undefined);
    });
    raw.on('connection', () => { tcp += 1; });
    await new Promise<void>((resolve) => raw!.listen(0, '127.0.0.1', () => resolve()));
    const port = (raw.address() as { port: number }).port;
    await expect(client(port, { tls: { allowSelfSigned: true, fingerprint256: OTHER_FP }, auth: AUTH }).subscribe())
      .rejects.toThrow(/does not match tlsCertFingerprint.*check tlsCertFingerprint/);
    await new Promise((r) => setTimeout(r, 50));
    expect(tcp).toBe(2); // the TCP reachability probe, then the refused TLS session
    expect(plaintext).toEqual([]);
  });

  it('without an explicit option and with credentials nothing is sent: one clear refusal', async () => {
    const port = await ccu();
    await expect(client(port, { tls: { allowSelfSigned: false }, auth: AUTH }).subscribe())
      .rejects.toThrow(TLS_CREDENTIALS_REFUSED);
    expect(requests).toEqual([]);
  });

  it('without an explicit option and without credentials the self-signed certificate is refused, with a hint', async () => {
    const port = await ccu();
    await expect(client(port, { tls: { allowSelfSigned: false } }).subscribe())
      .rejects.toThrow(/self[- ]signed.*set tlsCertFingerprint to pin it, or tlsAllowSelfSigned/);
    expect(requests).toEqual([]);
  });

  describe('JSON API over HTTPS uses the same rules', () => {
    async function jsonCcu(): Promise<{ port: number; bodies: string[] }> {
      const bodies: string[] = [];
      server = https.createServer({ key, cert }, (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          bodies.push(body);
          const method = (JSON.parse(body) as { method: string }).method;
          res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify({ version: '1.1', result: method === 'Session.login' ? 'SIDTLS' : 'ok', error: null }));
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
      return { port: (server.address() as { port: number }).port, bodies };
    }
    const api = (port: number, opts: { allowSelfSigned: boolean; fingerprint256?: string }): CcuJsonRpcClient => new CcuJsonRpcClient({
      host: '127.0.0.1', port, useTls: true, timeoutMs: 2000, auth: AUTH,
      tlsAgent: ccuTlsAgent(opts, true), log: new PrefixedLogger(makeLog(), 'json-tls'),
    });

    it('a pinned certificate carries the login', async () => {
      const { port, bodies } = await jsonCcu();
      await expect(api(port, { allowSelfSigned: false, fingerprint256: fingerprint }).call('Anything')).resolves.toBe('ok');
      expect(bodies.map((b) => (JSON.parse(b) as { method: string }).method)).toEqual(['Session.login', 'Anything']);
    });

    it('a different certificate never receives the password', async () => {
      const { port, bodies } = await jsonCcu();
      await expect(api(port, { allowSelfSigned: false, fingerprint256: OTHER_FP }).call('Anything')).rejects.toThrow();
      expect(bodies).toEqual([]);
    });

    it('no pin and no tlsAllowSelfSigned: the login is refused with the clear error, nothing sent', async () => {
      const { port, bodies } = await jsonCcu();
      const err = await api(port, { allowSelfSigned: false }).call('Anything').catch((e: Error) => e);
      expect(String((err as Error & { cause?: Error }).cause?.message ?? (err as Error).message)).toContain(TLS_CREDENTIALS_REFUSED);
      expect(bodies).toEqual([]);
    });
  });

  it('tlsAllowSelfSigned accepts it', async () => {
    const port = await ccu();
    await client(port, { tls: { allowSelfSigned: true }, auth: AUTH }).subscribe();
    expect(requests).toHaveLength(1);
  });

  it('scripts/ccu-cert-fingerprint.mjs prints the fingerprint for tlsCertFingerprint', async () => {
    const port = await ccu();
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'ccu-cert-fingerprint.mjs');
    const { execFile } = await import('node:child_process');
    const out = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, [script, '127.0.0.1', String(port)], { timeout: 8000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    expect(out).toContain(`tlsCertFingerprint: ${fingerprint}`);
    expect(requests).toEqual([]);
  });

  it('sends no Authorization header when no auth is configured', async () => {
    const port = await ccu();
    await client(port, { tls: { allowSelfSigned: false, fingerprint256: fingerprint } }).subscribe();
    expect(requests).toEqual([{ authorization: undefined }]);
  });
});

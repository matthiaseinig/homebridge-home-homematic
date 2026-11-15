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
import { Buffer } from 'node:buffer';
import { ccuTlsAgent, normalizeFingerprint, TLS_INTERFACE_PORTS } from '../../src/ccu/ccuTls.js';
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

  it('without an explicit option the self-signed certificate is refused, with a hint', async () => {
    const port = await ccu();
    await expect(client(port, { tls: { allowSelfSigned: false }, auth: AUTH }).subscribe())
      .rejects.toThrow(/self[- ]signed.*set tlsCertFingerprint to pin it, or tlsAllowSelfSigned/);
    expect(requests).toEqual([]);
  });

  it('tlsAllowSelfSigned accepts it', async () => {
    const port = await ccu();
    await client(port, { tls: { allowSelfSigned: true }, auth: AUTH }).subscribe();
    expect(requests).toHaveLength(1);
  });

  it('sends no Authorization header when no auth is configured', async () => {
    const port = await ccu();
    await client(port, { tls: { allowSelfSigned: false, fingerprint256: fingerprint } }).subscribe();
    expect(requests).toEqual([{ authorization: undefined }]);
  });
});

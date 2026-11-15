/**
 * RpcClient against a real local HTTP server that behaves like a CCU with
 * "Authentication" enabled: 401 + HTML without valid Basic credentials,
 * XML-RPC with them. Uses the real homematic-xmlrpc client and TCP probe.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { Buffer } from 'node:buffer';
import { RpcClient, basicAuthHeader } from '../../src/ccu/RpcClient.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';

const USER = 'hb-test';
const PASS = 'not-a-real-secret';
const OK_XML = '<?xml version="1.0"?><methodResponse><params><param><value></value></param></params></methodResponse>';
const HTML_401 = '<!DOCTYPE html>\n<html lang="en"><head><title>401 Unauthorized</title></head><body><h1>401 Unauthorized</h1></body></html>';

let server: http.Server;
let port = 0;
let seen: Array<{ authorization?: string; body: string }> = [];

beforeEach(async () => {
  seen = [];
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ authorization: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
      if (req.headers.authorization !== basicAuthHeader({ username: USER, password: PASS })) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="theRealm"', 'Content-Type': 'text/html', Connection: 'close' });
        res.end(HTML_401);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(OK_XML);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client(auth?: { username: string; password: string }): RpcClient {
  return new RpcClient({
    interfaceId: 'BidCos-RF',
    host: '127.0.0.1',
    port,
    callbackUrl: 'http://192.0.2.10:9875',
    callbackId: 'cb-test',
    auth,
    log: new PrefixedLogger(makeLog(), 'rpc-auth'),
  });
}

describe('RpcClient HTTP Basic auth for CCU XML-RPC ports', () => {
  it('basicAuthHeader encodes user:password', () => {
    expect(basicAuthHeader({ username: 'a', password: 'b:c' })).toBe(`Basic ${Buffer.from('a:b:c').toString('base64')}`);
  });

  it('subscribes with credentials and sends them on every call', async () => {
    const c = client({ username: USER, password: PASS });
    await c.subscribe();
    expect(c.isSubscribed()).toBe(true);
    await c.unsubscribe();
    expect(seen).toHaveLength(2);
    expect(seen.every((r) => r.authorization === basicAuthHeader({ username: USER, password: PASS }))).toBe(true);
    expect(seen[0]!.body).toContain('<methodName>init</methodName>');
    expect(seen[0]!.body).toContain('http://192.0.2.10:9875');
  });

  it('without credentials the 401 page is reported with an auth hint, not just "Invalid XML-RPC message"', async () => {
    const c = client();
    await expect(c.subscribe()).rejects.toThrow(/Invalid XML-RPC message.*HTTP 401.*enable ccuAuth/);
    expect(c.isSubscribed()).toBe(false);
    expect(seen[0]!.authorization).toBeUndefined();
  });

  it('with rejected credentials the hint says the ccuAuth user was rejected', async () => {
    const c = client({ username: USER, password: 'wrong' });
    await expect(c.subscribe()).rejects.toThrow(/HTTP 401.*ccuAuth user was rejected/);
  });
});

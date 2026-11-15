#!/usr/bin/env node
/**
 * Print the SHA-256 fingerprint of the CCU's TLS certificate, for the
 * plugin setting `tlsCertFingerprint`. Needs only Node (no openssl).
 *
 *   node ccu-cert-fingerprint.mjs <ccu-host> [port] [--verbose]
 *
 * Prints only the fingerprint line; --verbose adds subject, issuer and
 * expiry. Port defaults to 42001 (BidCos-RF XML-RPC over TLS). A CCU serves the
 * same certificate on 443, 42001, 42010 and 49292; compare two ports if in
 * doubt. Run it on a trusted network: it accepts whatever certificate it
 * is shown, which is the point of reading the fingerprint once.
 */

import { connect } from 'node:tls';
import { isIP } from 'node:net';
import process from 'node:process';

const out = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);

const TIMEOUT_MS = 10_000;

function usage(message) {
  if (message) err(message);
  err('usage: node ccu-cert-fingerprint.mjs <ccu-host> [port] [--verbose]');
  process.exit(2);
}

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const [host, portArg = '42001'] = args.filter((a) => a !== '--verbose');
if (!host || host.startsWith('-')) usage();
const port = Number(portArg);
if (!Number.isInteger(port) || port < 1 || port > 65535) usage(`invalid port: ${portArg}`);

const socket = connect({
  host,
  port,
  rejectUnauthorized: false,
  ...(isIP(host) ? {} : { servername: host }),
});
socket.setTimeout(TIMEOUT_MS, () => {
  err(`timeout connecting to ${host}:${port}`);
  socket.destroy();
  process.exit(1);
});
socket.once('secureConnect', () => {
  const cert = socket.getPeerCertificate();
  if (!cert || !cert.fingerprint256) {
    err(`${host}:${port} presented no certificate`);
    socket.destroy();
    process.exit(1);
  }
  out(`tlsCertFingerprint: ${cert.fingerprint256}`);
  if (verbose) out(`subject CN: ${cert.subject?.CN ?? '?'}; issuer CN: ${cert.issuer?.CN ?? '?'}; valid until: ${cert.valid_to}`);
  socket.end();
});
socket.once('error', (e) => {
  err(`cannot read the certificate of ${host}:${port}: ${e.message}`);
  process.exit(1);
});

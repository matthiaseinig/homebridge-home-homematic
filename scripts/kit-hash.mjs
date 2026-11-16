#!/usr/bin/env node
/**
 * Checks the copied home-ui-kit folder (homebridge-ui/public/kit/). Every
 * kit file starts with a version header that carries the SHA-256 of the
 * rest of the file:
 *
 *   /* home-ui-kit <file> <version> sha256:<hex> *\/
 *
 * A copy that was edited without updating the header fails the check, so
 * the plugins that share the kit notice drift.
 *
 *   node scripts/kit-hash.mjs           check (exit 1 on a mismatch)
 *   node scripts/kit-hash.mjs --write   recompute the hashes after an intended kit change
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const KIT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'homebridge-ui', 'public', 'kit');
const HEADER_RE = /^\/\* home-ui-kit (\S+) (\d+\.\d+\.\d+) sha256:([0-9a-f]{64}|PENDING) \*\/$/;

function splitHeader(text) {
  const nl = text.indexOf('\n');
  return nl === -1 ? [text, ''] : [text.slice(0, nl), text.slice(nl + 1)];
}

export function bodyHash(body) {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** One result per kit file: { file, ok, version, expected, actual, error }. */
export function checkKit(dir = KIT_DIR) {
  return readdirSync(dir).filter((f) => f.endsWith('.js')).sort().map((file) => {
    const [header, body] = splitHeader(readFileSync(join(dir, file), 'utf8'));
    const m = HEADER_RE.exec(header);
    if (!m) return { file, ok: false, error: 'missing or malformed version header' };
    if (m[1] !== file) return { file, ok: false, error: `header names ${m[1]}` };
    const actual = bodyHash(body);
    return { file, ok: m[3] === actual, version: m[2], expected: m[3], actual };
  });
}

export function writeKitHashes(dir = KIT_DIR) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const path = join(dir, file);
    const [header, body] = splitHeader(readFileSync(path, 'utf8'));
    const m = HEADER_RE.exec(header);
    if (!m) throw new Error(`${file}: missing or malformed version header`);
    writeFileSync(path, `/* home-ui-kit ${m[1]} ${m[2]} sha256:${bodyHash(body)} */\n${body}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) writeKitHashes();
  const results = checkKit();
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.file}${r.version ? ` ${r.version}` : ''}${r.error ? `: ${r.error}` : r.ok ? '' : ': content does not match the header hash'}`);
  }
  process.exit(results.length > 0 && results.every((r) => r.ok) ? 0 : 1);
}

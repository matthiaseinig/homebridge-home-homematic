import { describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain ES module without types
import { KIT_DIR, checkKit, writeKitHashes } from '../../scripts/kit-hash.mjs';

describe('home-ui-kit hash check', () => {
  it('the shipped kit matches its version headers', () => {
    const results = checkKit();
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r, r.file).toMatchObject({ ok: true, version: '1.0.0' });
  });

  it('detects an edited copy and a missing header; --write repairs the hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hm-kit-hash-test-'));
    try {
      cpSync(KIT_DIR, dir, { recursive: true });
      const file = join(dir, 'link.js');
      writeFileSync(file, readFileSync(file, 'utf8') + '\n// local edit\n');
      expect(checkKit(dir).find((r: any) => r.file === 'link.js')).toMatchObject({ ok: false });
      writeKitHashes(dir);
      expect(checkKit(dir).every((r: any) => r.ok)).toBe(true);
      writeFileSync(join(dir, 'other.js'), 'export {};\n');
      expect(checkKit(dir).find((r: any) => r.file === 'other.js')).toMatchObject({ ok: false, error: expect.stringContaining('header') });
      expect(() => writeKitHashes(dir)).toThrow(/header/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

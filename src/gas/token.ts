import { randomBytes } from 'node:crypto';
import { chmod, readFile } from 'node:fs/promises';
import { writeFileAtomic } from './files.js';

export const GAS_TOKEN_FILE = 'gas-api-token';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

/**
 * The bearer token of the gas API, kept in `path` (inside the Homebridge
 * storage folder, mode 0600). A missing or malformed file is replaced by a
 * new random token (32 bytes, base64url). The token is never logged; the
 * owner copies it from the file.
 */
export async function loadOrCreateToken(path: string): Promise<{ token: string; created: boolean }> {
  try {
    const text = (await readFile(path, 'utf8')).trim();
    if (TOKEN_PATTERN.test(text)) {
      await chmod(path, 0o600).catch(() => undefined);
      return { token: text, created: false };
    }
  } catch {
    // missing or unreadable: create a new one
  }
  const token = randomBytes(32).toString('base64url');
  await writeFileAtomic(path, `${token}\n`);
  return { token, created: true };
}

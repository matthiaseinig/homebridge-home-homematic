import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export const FILE_MODE = 0o600;

/**
 * Write a file atomically with owner-only permissions: temp file, fsync, then
 * rename into place. A crash leaves either the old or the new content.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fh = await open(tmp, 'w', FILE_MODE);
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await chmod(tmp, FILE_MODE);
  await rename(tmp, path);
}

/** Move an unreadable file aside so it is never overwritten. Returns the backup path. */
export async function backupAside(path: string, nowMs: number): Promise<string> {
  const target = `${path}.bak-${nowMs}`;
  await rename(path, target);
  return target;
}

/**
 * Read a JSON file. Missing: undefined. Unreadable, corrupt or rejected by
 * `valid`: moved aside to `<file>.bak-<time>` (never overwritten), `onBackup`
 * is told, undefined is returned.
 */
export async function readJsonOrBackup<T>(
  path: string,
  valid: (raw: unknown) => raw is T,
  onBackup: (backup: string) => void,
  nowMs: number,
): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  if (valid(raw)) return raw;
  try {
    onBackup(await backupAside(path, nowMs));
  } catch {
    // could not move it aside; the next write replaces it
  }
  return undefined;
}

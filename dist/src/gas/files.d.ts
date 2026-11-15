export declare const FILE_MODE = 384;
/**
 * Write a file atomically with owner-only permissions: temp file, fsync, then
 * rename into place. A crash leaves either the old or the new content.
 */
export declare function writeFileAtomic(path: string, data: string): Promise<void>;
/** Move an unreadable file aside so it is never overwritten. Returns the backup path. */
export declare function backupAside(path: string, nowMs: number): Promise<string>;
/**
 * Read a JSON file. Missing: undefined. Unreadable, corrupt or rejected by
 * `valid`: moved aside to `<file>.bak-<time>` (never overwritten), `onBackup`
 * is told, undefined is returned.
 */
export declare function readJsonOrBackup<T>(path: string, valid: (raw: unknown) => raw is T, onBackup: (backup: string) => void, nowMs: number): Promise<T | undefined>;

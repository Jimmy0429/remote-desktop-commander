import { closeSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

interface LockDatabase { exec(sql: string): void; close(): void }
const require = createRequire(import.meta.url);
const marker = 'Jimmy Remote Commander SQLite directory lock v1\n';
class LegacyLockError extends Error {
  constructor() { super('Legacy or unrecognized server.lock requires manual recovery. Confirm every old server using this directory has stopped before removing only an obsolete legacy server.lock file.'); }
}
function hasMarker(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Buffer.byteLength(marker) || readFileSync(path, 'utf8') !== marker) throw new LegacyLockError();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if (error instanceof LegacyLockError) throw error;
    throw new Error('Server lock state is unavailable. Check the private local data directory.');
  }
}
function installMarker(dataDir: string, path: string): void {
  if (hasMarker(path)) return;
  const temporary = join(dataDir, `server-lock-migration-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, marker); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // An old binary may have created its PID lock after the first check.
      if (!hasMarker(path)) throw new LegacyLockError();
    }
  } finally { unlinkSync(temporary); }
}

/** A local-filesystem OS lock: never reclaimed by age, PID, or deleting its inode. */
export function acquireServerLock(dataDir: string): () => void {
  const legacy = join(dataDir, 'server.lock');
  hasMarker(legacy); // Unknown/PID locks are never automatically reclaimed.

  const path = join(dataDir, 'server-lock.sqlite');
  let database: LockDatabase | undefined;
  try {
    // Reject links and special files before SQLite opens any lock state. The
    // private data directory and lock inode must not be replaced while in use.
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        const stat = lstatSync(path + suffix);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid lock state.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    // O_EXCL failure opens no descriptor. Never open/read this inode through fs
    // while held: closing another fd can drop POSIX advisory locks in this process.
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }

    // Lazy loading keeps node:sqlite out of agent-only processes. Node 22.13+
    // supports this built-in without a flag; only its original API is used.
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => LockDatabase };
    database = new DatabaseSync(path);
    // Initialize and commit before the lifetime transaction. Keeping that
    // transaction free of writes avoids a hot journal after a process crash.
    database.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE; PRAGMA user_version = 1; COMMIT; BEGIN EXCLUSIVE;');
    // A complete, persistent marker also prevents old open('wx') servers from
    // starting against a migrated directory, including after this server exits.
    installMarker(dataDir, legacy);
  } catch (error) {
    try { database?.close(); } catch { /* Preserve the redacted lock error. */ }
    if (error instanceof LegacyLockError) throw error;
    throw new Error('Server data directory is locked or its lock state is unavailable. Stop any other server and check the private local data directory.');
  }

  return () => {
    if (!database) return;
    database.close(); // Rolls back the held transaction and releases the OS lock.
    database = undefined;
  };
}

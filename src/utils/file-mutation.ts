import { stat } from 'node:fs/promises';
import { runWithAbortableTimeout } from './withTimeout.js';

// Pending mutations in this engine only. Other processes, including editors
// and terminal commands, do not participate in this queue.
const pending = new Map<string, Promise<void>>();

async function mutationKeys(canonicalPath: string): Promise<string[]> {
    // The name also covers a fresh file that has no inode until a write starts.
    // Case-folding here can only make two different spellings wait unnecessarily;
    // the actual filesystem operations always use the original validated path.
    const keys = ['path:' + canonicalPath.normalize('NFC').toLowerCase()];
    try {
        const info = await runWithAbortableTimeout(() => stat(canonicalPath, { bigint: true }), 10000, 'File identity check');
        if (info.ino !== 0n) keys.push(`file:${info.dev}:${info.ino}`);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    return keys;
}

/** Reserve all inputs and outputs together, so overlapping edits cannot deadlock. */
export async function withFileMutation<T>(canonicalPaths: string[], mutate: () => Promise<T>): Promise<T> {
    const groups = await Promise.all(Array.from(new Set(canonicalPaths), mutationKeys));
    const keys = new Set(groups.flat());
    const previous = Array.from(keys, key => pending.get(key));
    const result = Promise.all(previous).then(mutate);
    // A failed mutation still releases the next one. Its own caller receives the error.
    const done = result.then(() => {}, () => {});
    for (const key of keys) pending.set(key, done);
    try {
        return await result;
    } finally {
        for (const key of keys) {
            if (pending.get(key) === done) pending.delete(key);
        }
    }
}

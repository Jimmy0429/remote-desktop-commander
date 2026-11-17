import { closeSync, fsyncSync, linkSync, lstatSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertPrivateFile, ensurePrivateDirectory, readPrivateTextFile } from './private-storage.js';
import { safeRemoteUrl } from './protocol.js';

export interface DeviceCredential {
  serverUrl: string;
  deviceId?: string;
  deviceToken: string;
}

// Earlier credential files could omit deviceId. They can still start an
// agent, but cannot satisfy an explicit --device-id check.
export function parseCredential(text: string): DeviceCredential {
  try {
    const saved = JSON.parse(text);
    if (typeof saved?.serverUrl === 'string' && typeof saved.deviceToken === 'string' &&
        (saved.deviceId === undefined || typeof saved.deviceId === 'string')) {
      return { serverUrl: safeRemoteUrl(saved.serverUrl).origin, deviceId: saved.deviceId, deviceToken: saved.deviceToken };
    }
  } catch { /* A JSON parser diagnostic can include part of the credential. */ }
  throw new Error('Invalid device credential file.');
}

const validDeviceId = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const validToken = /^jrc_device_[A-Za-z0-9_-]{43}$/;

export async function publishEnrollment(
  credentialFile: string, serverUrl: string, register: () => Promise<unknown>,
): Promise<DeviceCredential> {
  ensurePrivateDirectory(dirname(credentialFile));
  const pending = `${credentialFile}.pending`;
  const flags = { throwIfNoEntry: false } as const;
  if (lstatSync(credentialFile, flags)) throw new Error('Credential file already exists. Choose a fresh --credentials path.');
  let descriptor: number | undefined;
  try {
    descriptor = openSync(pending, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Enrollment is in progress or was interrupted. Inspect the owner dashboard and the enrollment recovery guide before retrying.');
    }
    throw error;
  }
  let deviceId: string | undefined;
  try {
    assertPrivateFile(pending);
    // The reservation excludes another enrollment between the path check
    // and contacting the server. Recheck once we own the reservation.
    if (lstatSync(credentialFile, flags)) throw new Error('Credential file already exists. Choose a fresh --credentials path.');
    try {
      const reply = await register();
      if (!reply || typeof reply !== 'object' ||
          !('deviceId' in reply) || typeof reply.deviceId !== 'string' || !validDeviceId.test(reply.deviceId) ||
          !('token' in reply) || typeof reply.token !== 'string' || !validToken.test(reply.token)) {
        throw new Error('Invalid enrollment response.');
      }
      deviceId = reply.deviceId;
      const credential = { serverUrl, deviceId, deviceToken: reply.token };
      const serialized = JSON.stringify(credential, null, 2);
      writeFileSync(descriptor, serialized + '\n', 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      // An atomic, no-overwrite publication on local NTFS/POSIX filesystems.
      // The final path never names the empty reservation or a partial secret.
      linkSync(pending, credentialFile);
      if (readPrivateTextFile(credentialFile).trim() !== serialized) throw new Error('Saved credential verification failed.');
      return credential;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Enrollment failed.';
      const identity = deviceId ? `device ${deviceId}` : 'the new registration by name and time';
      throw new Error(`${detail} Enrollment may have reached the server. Check ${identity} in the owner dashboard before retrying.`);
    }
  } finally {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
    } finally {
      try {
        unlinkSync(pending);
      } catch (error) {
        // A transient Windows handle can block deletion after publication.
        // Preserve the verified enrollment or the original registration error.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          process.stderr.write('The protected pending file could not be removed. Follow the interrupted enrollment guide to clean it up.\n');
        }
      }
    }
  }
}

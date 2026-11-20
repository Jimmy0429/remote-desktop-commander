import { isAbsolute } from 'node:path';
import { startStdioBridge } from './bridge.js';
import { readPrivateTextFile } from './private-storage.js';
import { safeRemoteUrl } from './protocol.js';

// The desktop bundle exposes only the MCP bridge. The credential stays on disk
// until the separately configured server origin has passed validation.
async function main(): Promise<void> {
  const [origin, credentialFile, ...extra] = process.argv.slice(2);
  if (!origin || !credentialFile || extra.length || !isAbsolute(credentialFile)) {
    throw new Error('Configure the server origin and an absolute credential file path.');
  }
  let serverUrl: string;
  try { serverUrl = safeRemoteUrl(origin).origin; }
  catch { throw new Error('Set the private server origin to HTTPS or loopback HTTP.'); }
  let ownerToken: string;
  try { ownerToken = readPrivateTextFile(credentialFile); }
  catch { throw new Error('Check the private credential file path and its permissions.'); }
  const bridge = await startStdioBridge({ serverUrl, ownerToken }).catch(() => {
    throw new Error('Check the private server connection and credential.');
  });
  process.exitCode = (await bridge.closed).exitCode;
}

main().catch(error => {
  process.stderr.write((error instanceof Error ? error.message : 'Private bridge startup failed.') + '\n');
  process.exitCode = 1;
});

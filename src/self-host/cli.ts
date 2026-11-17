#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, lstatSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { safeRemoteUrl } from './protocol.js';
import { startAgent } from './agent.js';
import { createControlServer } from './server.js';

function privateWrite(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
}
function privateRead(file: string): string {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) throw new Error('Credential file must be a small regular file.');
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('Credential file is readable by other users. Set its permissions to 600.');
  return readFileSync(file, 'utf8').trim();
}
async function request(server: string, path: string, token?: string, body?: unknown): Promise<any> {
  const url = new URL(path, safeRemoteUrl(server));
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Server rejected the request (${response.status}). Check the server, credential, and pairing expiry.`);
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error('Server response is too large.');
  return JSON.parse(text);
}
function waitForStop(close: () => Promise<void>): void {
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    void close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    'data-dir': { type: 'string', default: '.self-host/server' }, 'host': { type: 'string' },
    'port': { type: 'string' }, 'public-url': { type: 'string' }, 'server': { type: 'string' },
    'token-file': { type: 'string' }, 'pairing-file': { type: 'string', default: '.self-host/pairing-code' },
    'credentials': { type: 'string', default: '.self-host/agent.json' }, 'name': { type: 'string' },
    'workspace': { type: 'string' }, 'state-dir': { type: 'string' }, 'device-id': { type: 'string' },
    'help': { type: 'boolean', short: 'h' },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(`Jimmy Remote Commander\n\nCommands: init, serve, pair, enroll, agent, devices, revoke\n\ninit --data-dir DIR\nserve --data-dir DIR [--host 127.0.0.1 --port 8787 --public-url https://your-host]\npair --server URL --token-file FILE --pairing-file FILE\nenroll --server URL --pairing-file FILE --credentials FILE [--name NAME]\nagent --credentials FILE --workspace DIR [--state-dir DIR]\ndevices --server URL --token-file FILE\nrevoke --server URL --token-file FILE --device-id ID\n\nCredentials are read from private files, never command-line token arguments.\nSee docs/self-hosted.md for setup and TLS deployment.`);
    return;
  }
  if (positionals.length !== 1) throw new Error('Unexpected positional arguments.');
  const dataDir = resolve(values['data-dir']!);
  const tokenFile = resolve(values['token-file'] || join(dataDir, 'owner-token'));
  if (command === 'init') {
    privateWrite(join(dataDir, 'owner-token'), randomBytes(32).toString('base64url') + '\n');
    console.log(`Server initialized. Owner credential saved privately to ${join(dataDir, 'owner-token')}.\nStart with: npm run self-host -- serve --data-dir "${dataDir}"`);
    return;
  }
  if (command === 'serve') {
    const server = await createControlServer({ dataDir, ownerToken: privateRead(tokenFile),
      host: values.host, port: values.port === undefined ? undefined : Number(values.port), publicUrl: values['public-url'] });
    console.log(`Jimmy Remote Commander listening at ${server.url}\nDashboard: ${server.url}/\nMCP endpoint: ${server.url}/mcp\nPress Ctrl+C to stop.`);
    waitForStop(server.close); return;
  }
  const credentialFile = resolve(values.credentials!);
  if (command === 'agent') {
    const saved = JSON.parse(privateRead(credentialFile));
    if (!saved || typeof saved.serverUrl !== 'string' || typeof saved.deviceToken !== 'string') throw new Error('Invalid device credential file.');
    if (!values.workspace) throw new Error('Choose --workspace DIR for the device tool engine.');
    const agent = await startAgent({ serverUrl: saved.serverUrl, deviceToken: saved.deviceToken,
      workspace: resolve(values.workspace), stateDir: resolve(values['state-dir'] || join(dirname(credentialFile), 'engine')) });
    console.log('Device connected. Keep this process running; press Ctrl+C to disconnect.');
    waitForStop(agent.close); return;
  }
  if (!values.server) throw new Error('--server URL is required.');
  const serverUrl = safeRemoteUrl(values.server).origin;
  const pairingFile = resolve(values['pairing-file']!);
  if (command === 'pair') {
    if (existsSync(pairingFile)) throw new Error('Pairing file already exists. Choose a new --pairing-file path.');
    const pairing = await request(serverUrl, '/api/pairings', privateRead(tokenFile), {});
    if (typeof pairing.code !== 'string' || typeof pairing.expiresAt !== 'string') throw new Error('Invalid pairing response.');
    privateWrite(pairingFile, pairing.code + '\n');
    console.log(`Pairing code saved privately to ${pairingFile}. Expires ${pairing.expiresAt}.\nTransfer this file privately to the computer to enroll.`);
    return;
  }
  if (command === 'enroll') {
    const code = privateRead(pairingFile);
    // Reserve the credential path before consuming the one-use pairing code.
    privateWrite(credentialFile, '');
    try {
      const enrolled = await request(serverUrl, '/api/enroll', undefined, { code, name: values.name || hostname(), platform: process.platform });
      if (typeof enrolled.deviceId !== 'string' || typeof enrolled.token !== 'string' || !/^jrc_device_[A-Za-z0-9_-]{43}$/.test(enrolled.token)) throw new Error('Invalid enrollment response.');
      writeFileSync(credentialFile, JSON.stringify({ serverUrl, deviceId: enrolled.deviceId, deviceToken: enrolled.token }, null, 2) + '\n', { mode: 0o600 });
      console.log(`Device enrolled as ${enrolled.deviceId}. Credential saved privately to ${credentialFile}.\nStart the agent with --credentials and --workspace.`);
    } catch (e) { if (readFileSync(credentialFile, 'utf8') === '') unlinkSync(credentialFile); throw e; }
    return;
  }
  const ownerToken = privateRead(tokenFile);
  if (command === 'devices') { console.log(JSON.stringify((await request(serverUrl, '/api/devices', ownerToken)).devices, null, 2)); return; }
  if (command === 'revoke') {
    if (!values['device-id'] || !/^[a-zA-Z0-9-]{1,128}$/.test(values['device-id'])) throw new Error('--device-id is required.');
    await request(serverUrl, `/api/devices/${values['device-id']}/revoke`, ownerToken, {});
    console.log('Device access revoked.'); return;
  }
  throw new Error('Unknown command. Use --help.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Command failed.'); process.exitCode = 1; });
}

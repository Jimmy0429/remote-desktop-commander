#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { hostname, homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { safeRemoteUrl } from './protocol.js';
import { startAgent } from './agent.js';
import { createControlServer } from './server.js';
import { readPrivateTextFile as privateRead, writePrivateFile, protectPrivateDirectory } from './private-storage.js';
import { publishEnrollment, parseCredential, type DeviceCredential } from './enrollment.js';
import { startStdioBridge } from './bridge.js';

function privateWrite(file: string, content: string): void {
  writePrivateFile(file,content);
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
  try { return JSON.parse(text); }
  catch { throw new Error('Server returned invalid JSON.'); }
}
function waitForStop(close: () => Promise<void>): void {
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    void close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

async function runAgent(saved: DeviceCredential, workspace: string, stateDir: string): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  // Cancellation also applies while the first connection is retrying.
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const agent = await startAgent({
      serverUrl: saved.serverUrl,
      deviceToken: saved.deviceToken,
      workspace,
      stateDir,
      signal: controller.signal,
      onStatus(status) {
        if (status.state === 'connected') console.log(status.message);
        if (status.state === 'retrying') {
          const seconds = ((status.retryDelayMs || 0) / 1000).toFixed(1);
          console.error(`${status.message} Next attempt in ${seconds} seconds. Press Ctrl+C to stop.`);
        }
      },
    });
    const exit = await agent.closed;
    if (exit.exitCode !== 0) console.error(exit.message);
    process.exitCode = exit.exitCode;
  } catch (error) {
    if (!controller.signal.aborted || !(error instanceof Error) || error.name !== 'AbortError') throw error;
    process.exitCode = 0;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const stateRoot = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'JimmyRemoteCommander')
    : '.self-host';
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    'data-dir': { type: 'string', default: join(stateRoot, 'server') }, 'host': { type: 'string' },
    'port': { type: 'string' }, 'public-url': { type: 'string' }, 'server': { type: 'string' },
    'token-file': { type: 'string' }, 'pairing-file': { type: 'string', default: join(stateRoot, 'pairing-code') },
    'credentials': { type: 'string', default: join(stateRoot, 'agent.json') }, 'name': { type: 'string' },
    'workspace': { type: 'string' }, 'state-dir': { type: 'string' }, 'device-id': { type: 'string' },
    'start-agent': { type: 'boolean' },
    'help': { type: 'boolean', short: 'h' },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(`Jimmy Remote Commander\n\nCommands: init, protect, serve, pair, enroll, agent, bridge, devices, revoke\n\ninit --data-dir DIR\nprotect --data-dir DIR (explicit permission repair for dedicated state)\nserve --data-dir DIR [--host 127.0.0.1 --port 8787 --public-url https://your-host]\npair --server URL --token-file FILE --pairing-file FILE\nenroll --server URL --pairing-file FILE --credentials FILE [--name NAME] [--start-agent --workspace DIR]\nagent --credentials FILE --workspace DIR [--state-dir DIR] [--server URL] [--device-id ID]\nbridge --server URL --token-file FILE\ndevices --server URL --token-file FILE\nrevoke --server URL --token-file FILE --device-id ID\n\nCredentials are read from private files, never command-line token arguments.\nWindows defaults use LocalAppData/JimmyRemoteCommander.\nSee docs/self-hosted.md for setup and TLS deployment.`);
    return;
  }
  if (positionals.length !== 1) throw new Error('Unexpected positional arguments.');
  if (values['start-agent'] && command !== 'enroll') throw new Error('--start-agent is available only for enrollment.');
  const dataDir = resolve(values['data-dir']!);
  const tokenFile = resolve(values['token-file'] || join(dataDir, 'owner-token'));
  if (command === 'protect') {
    protectPrivateDirectory(dataDir);
    console.log('Dedicated application state is private. Other directories were not changed.');
    return;
  }
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
  const stateDir = resolve(values['state-dir'] || join(dirname(credentialFile), 'engine'));
  if (command === 'agent') {
    const saved = parseCredential(privateRead(credentialFile));
    if (!values.workspace) throw new Error('Choose --workspace DIR for the device tool engine.');
    if (values.server && saved.serverUrl !== safeRemoteUrl(values.server).origin) {
      throw new Error('The credential belongs to a different server. Agent was not started.');
    }
    if (values['device-id'] && saved.deviceId !== values['device-id']) {
      throw new Error('Device ID does not match the credential. Agent was not started.');
    }
    await runAgent(saved, resolve(values.workspace), stateDir);
    return;
  }
  if (!values.server) throw new Error('--server URL is required.');
  const serverUrl = safeRemoteUrl(values.server).origin;
  if (command === 'bridge') {
    if (!values['token-file']) throw new Error('Choose --token-file FILE for the private MCP bridge.');
    const bridge = await startStdioBridge({ serverUrl, ownerToken: privateRead(tokenFile) });
    process.exitCode = (await bridge.closed).exitCode;
    return;
  }
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
    let workspace: string | undefined;
    if (values['start-agent']) {
      if (!values.workspace) throw new Error('Choose --workspace DIR before enrolling and starting the agent.');
      workspace = resolve(values.workspace);
      if (!statSync(workspace).isDirectory()) throw new Error('Workspace must be a directory.');
    }
    const code = privateRead(pairingFile);
    const credential = await publishEnrollment(credentialFile, serverUrl, () =>
      request(serverUrl, '/api/enroll', undefined, { code, name: values.name || hostname(), platform: process.platform }));
    console.log(`Device enrolled as ${credential.deviceId} at ${serverUrl}. Credential saved privately to ${credentialFile}.`);
    if (workspace) {
      if (privateRead(pairingFile) !== code) {
        throw new Error('The pairing file changed during enrollment. Check the saved device identity before starting the agent.');
      }
      unlinkSync(pairingFile);
      console.log(`Starting device ${credential.deviceId} with workspace ${workspace}.`);
      await runAgent(credential, workspace, stateDir);
    }
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

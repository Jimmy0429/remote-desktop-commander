import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import portable from './app/portable.cjs';

const {
  VERSION, startAgent, runUsbCheck, safeRemoteUrl, ensurePrivateDirectory,
  readPrivateTextFile, publishEnrollment, parseCredential,
} = portable;
const deviceName = 'Windows USB pilot';

class Cancelled extends Error {}

function contains(parent, child) {
  const rel = relative(parent, child);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}

function localDataDirectory() {
  const local = process.env.LOCALAPPDATA;
  if (process.platform !== 'win32' || !local || !/^[a-z]:[\\/]/i.test(local)) {
    throw new Error('This package requires Windows with a local user profile.');
  }
  const packageDir = dirname(fileURLToPath(import.meta.url));
  const pilot = resolve(local, 'JimmyRemoteCommander', 'usb-pilot');
  if (contains(packageDir, resolve(local)) || contains(packageDir, pilot) || contains(pilot, packageDir)) {
    throw new Error('Keep the extracted USB package separate from its private user profile folder.');
  }
  return resolve(local);
}

// readline handles the Windows console in raw mode. Suppress its automatic
// echo, including pasted multi-line input, while showing our own prompts.
// The line iterator also preserves all lines when a test pipes its responses.
function consolePrompts() {
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const rl = createInterface({ input: process.stdin, output: muted, terminal, historySize: 0, crlfDelay: Infinity });
  const lines = rl[Symbol.asyncIterator]();
  rl.on('SIGINT', () => rl.close());
  return {
    terminal,
    close: () => rl.close(),
    async ask(prompt) {
      process.stdout.write(prompt + ' ');
      const row = await lines.next();
      if (terminal) process.stdout.write('\n');
      if (row.done) throw new Cancelled();
      return row.value.trim();
    },
  };
}

async function confirm(prompts, word, message) {
  if (await prompts.ask(message) !== word) throw new Cancelled();
}

function freshDirectory(parent, prefix) {
  const directory = join(parent, prefix + randomUUID());
  if (lstatSync(directory, { throwIfNoEntry: false })) throw new Error('Could not reserve a fresh pilot folder.');
  ensurePrivateDirectory(directory);
  return directory;
}

async function check(prompts, local) {
  console.log('Check the USB package with a disposable loopback relay and one test file.');
  await confirm(prompts, 'CHECK', 'Type CHECK and press Enter to run locally, or press Enter to cancel.');
  const scratch = freshDirectory(local, 'JimmyRemoteCommander-USB-check-');
  try {
    const workspace = join(scratch, 'workspace');
    const stateDir = join(scratch, 'state');
    ensurePrivateDirectory(workspace);
    ensurePrivateDirectory(stateDir);
    const result = await runUsbCheck({ workspace, stateDir });
    if (result.version !== VERSION) throw new Error('USB check returned a different package version.');
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
  console.log(`PASS: Jimmy Remote Commander ${VERSION} wrote and read its disposable test file.`);
}

async function register(serverUrl, code, signal) {
  const response = await fetch(new URL('/api/enroll', serverUrl), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name: deviceName, platform: 'win32' }),
    redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Enrollment was refused (HTTP ${response.status}). Check the server and pairing expiry.`);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 16 * 1024) throw new Error('Enrollment response exceeded its size limit.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('The server did not return a valid enrollment.'); }
}

async function start(prompts, local) {
  const base = join(local, 'JimmyRemoteCommander', 'usb-pilot');
  const state = join(base, 'state');
  const credentialFile = join(state, 'agent.json');
  console.log('This foreground pilot lets the selected relay read and write one disposable text file.');
  console.log('Continue on a work PC only with approval to run the agent and connect to that relay.');
  console.log(`Local device credential: ${credentialFile}`);
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('Enable TLS certificate verification before pairing or connecting.');
  }
  let saved, origin, code;
  if (lstatSync(credentialFile, { throwIfNoEntry: false })) {
    saved = parseCredential(readPrivateTextFile(credentialFile));
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(saved.deviceId ?? '')) {
      throw new Error('The saved pilot device identity is invalid.');
    }
    console.log(`Saved server: ${saved.serverUrl}\nDevice ID: ${saved.deviceId}`);
    await confirm(prompts, 'START', 'Check the server and device ID. Type START to connect, or press Enter to cancel.');
  } else {
    const address = await prompts.ask('Enter the approved server origin (https://name or local loopback HTTP):');
    if (!address) throw new Cancelled();
    try { origin = safeRemoteUrl(address).origin; }
    catch { throw new Error('Enter the HTTPS server origin or loopback HTTP origin, without a path or credentials.'); }
    console.log(`Selected server: ${origin}\nDevice label: ${deviceName}`);
    await confirm(prompts, 'PAIR', 'Type PAIR to enroll with this server, or press Enter to cancel.');
    code = await prompts.ask('Paste the one-use pairing code from the owner dashboard and press Enter (input hidden):');
    if (!/^jrc_pair_[A-Za-z0-9_-]{32}$/.test(code)) throw new Error('A one-use device pairing code is required.');
  }
  prompts.close();
  ensurePrivateDirectory(base);
  ensurePrivateDirectory(state);
  const workspaces = join(base, 'workspaces');
  ensurePrivateDirectory(workspaces);
  const workspace = freshDirectory(workspaces, 'session-');
  const pilotFile = join(workspace, 'pilot-check.txt');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (!saved) {
      saved = await publishEnrollment(credentialFile, origin, () => register(origin, code, controller.signal));
      console.log(`Paired device ${saved.deviceId} at ${saved.serverUrl}`);
    }
    console.log(`Pilot file: ${pilotFile}\nLeave this console open. Press Ctrl+C to end this session.`);
    const agent = await startAgent({
      serverUrl: saved.serverUrl, deviceToken: saved.deviceToken,
      stateDir: join(state, 'engine'), workspace, portablePilotFile: pilotFile,
      signal: controller.signal, onStatus: status => console.log(status.message),
    });
    const exit = await agent.closed;
    console.log(exit.message);
    process.exitCode = exit.exitCode;
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || (mode !== 'check' && mode !== 'start')) {
    throw new Error('Open CHECK-USB.cmd or START-PILOT.cmd.');
  }
  const local = localDataDirectory();
  const prompts = consolePrompts();
  console.log(`Jimmy Remote Commander USB pilot ${VERSION}`);
  if (prompts.terminal) console.log('Console entries are hidden. Press Enter after each answer.');
  try {
    if (mode === 'check') {
      await check(prompts, local);
      if (prompts.terminal) await prompts.ask('Press Enter to close.');
    } else {
      await start(prompts, local);
    }
  } catch (error) {
    if (error instanceof Cancelled) { console.log('Cancelled.'); return; }
    console.error(error instanceof Error ? error.message : 'The USB pilot failed.');
    process.exitCode = 1;
  } finally { prompts.close(); }
  if (process.exitCode && prompts.terminal) {
    const end = consolePrompts();
    try { await end.ask('Press Enter to close.'); }
    catch (error) { if (!(error instanceof Cancelled)) throw error; }
    finally { end.close(); }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'The USB pilot failed.');
  process.exitCode = 1;
});

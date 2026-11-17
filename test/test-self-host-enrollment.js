import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { publishEnrollment } from '../dist/self-host/enrollment.js';
import { createControlServer } from '../dist/self-host/server.js';
import { ensurePrivateDirectory, writePrivateFile } from '../dist/self-host/private-storage.js';

const entry = fileURLToPath(new URL('../dist/self-host/cli.js', import.meta.url));
const cli = (...args) => promisify(execFile)(process.execPath, [entry, ...args], { timeout: 15000 });

test('credential publication reserves one registration without exposing a partial or overwriting an existing credential', async t => {
  const base = mkdtempSync(join(tmpdir(), 'jrc-enrollment-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const file = join(base, 'state', 'agent.json');
  const server = 'https://pilot.invalid';
  const reply = { deviceId: randomUUID(), token: 'jrc_device_' + randomBytes(32).toString('base64url') };
  await publishEnrollment(file, server, async () => {
    assert.equal(existsSync(file), false);
    await assert.rejects(publishEnrollment(file, server, () => assert.fail('second registration contacted server')), /in progress/);
    return reply;
  });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { serverUrl: server, deviceId: reply.deviceId, deviceToken: reply.token });
  assert.equal(existsSync(file + '.pending'), false);
  await assert.rejects(publishEnrollment(file, server, () => assert.fail('old identity must remain untouched')), /already exists/);
  const other = join(base, 'state', 'other.json');
  await assert.rejects(publishEnrollment(other, server, async () => { throw new Error('Lost response'); }), /may have reached the server/);
  assert.equal(existsSync(other), false);
  assert.equal(existsSync(other + '.pending'), false);
  await assert.rejects(publishEnrollment(other, server, async () => {
    writeFileSync(other, 'existing credentials', { flag: 'wx', mode: 0o600 });
    return reply;
  }), /check device/i);
  assert.equal(readFileSync(other, 'utf8'), 'existing credentials');
});

test('Windows pilot entry point starts only the just-enrolled identity and preserves unused pairing files', { timeout: 90000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'jrc-pilot-'));
  const state = join(base, 'state');
  ensurePrivateDirectory(state);
  const workspace = join(base, 'workspace'); mkdirSync(workspace);
  const ownerToken = randomBytes(32).toString('base64url');
  const server = await createControlServer({ dataDir: join(base, 'server'), ownerToken, port: 0 });
  const pairingFile = join(state, 'pairing-code');
  const credentialFile = join(state, 'agent.json');
  const api = async (path, method) => {
    const response = await fetch(server.url + path, { method, headers: { Authorization: 'Bearer ' + ownerToken, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(response.status, 200); return response.json();
  };
  const enroll = ['enroll', '--server', server.url, '--credentials', credentialFile, '--pairing-file', pairingFile, '--workspace', workspace, '--start-agent'];
  let child;
  let closed;
  try {
    writePrivateFile(pairingFile, (await api('/api/pairings', 'POST')).code);
    child = spawn(process.execPath, [entry, ...enroll], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); });
    closed = once(child, 'close');
    const deadline = Date.now() + 35000;
    let devices;
    do {
      ({ devices } = await api('/api/devices', 'GET'));
      if (devices.some(d => d.online)) break;
      assert.equal(child.exitCode, null, 'agent exited before reporting online');
      await sleep(100);
    } while (Date.now() < deadline);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].online, true);
    const saved = JSON.parse(readFileSync(credentialFile, 'utf8'));
    assert.equal(saved.deviceId, devices[0].id);
    assert.equal(saved.serverUrl, server.url);
    assert.equal(existsSync(pairingFile), false);
    assert.ok(output.includes(saved.deviceId) && output.includes(server.url));
    assert.ok(!output.includes(saved.deviceToken));
    const freshPairing = (await api('/api/pairings', 'POST')).code;
    writePrivateFile(pairingFile, freshPairing);
    await assert.rejects(cli(...enroll), /already exists/);
    assert.equal(readFileSync(pairingFile, 'utf8'), freshPairing);
    assert.equal((await api('/api/devices', 'GET')).devices.length, 1);
    assert.equal(JSON.parse(readFileSync(credentialFile, 'utf8')).deviceId, saved.deviceId);
    const agent = ['agent', '--workspace', workspace, '--credentials', credentialFile];
    await assert.rejects(cli(...agent, '--server', 'https://other.invalid'), /different server/);
    await assert.rejects(cli(...agent, '--server', server.url, '--device-id', randomUUID()), /Device ID does not match/);
    await api('/api/devices/' + saved.deviceId + '/revoke', 'POST');
    const [status] = await closed;
    assert.equal(status, 1);
    assert.ok(!output.includes(saved.deviceToken));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (closed) await closed;
    await server.close(); rmSync(base, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink, open, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createControlServer } from '../dist/self-host/server.js';

const token = () => randomBytes(32).toString('base64url');
function request(url, { host, origin, ownerToken, body, path = '/api/pairings' } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(new URL(path, url), {
      method: encoded === undefined ? 'GET' : 'POST', agent: false,
      headers: { ...(host ? { Host: host } : {}), ...(origin ? { Origin: origin } : {}),
        ...(ownerToken ? { Authorization: `Bearer ${ownerToken}` } : {}),
        ...(encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }) },
      signal: AbortSignal.timeout(3000),
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.once('error', reject); req.end(encoded);
  });
}
async function setup(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jrc-lifecycle-'));
  const ownerToken = token();
  const service = await createControlServer({ dataDir, ownerToken, port: 0, ...options });
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { ...service, dataDir, ownerToken };
}

test('dashboard mutations accept the matching localhost or IPv6 loopback origin', async t => {
  const s = await setup(t);
  const port = new URL(s.url).port;
  for (const name of ['localhost', '[::1]', '127.0.0.1']) {
    const host = `${name}:${port}`;
    const options = { host, origin: `http://${host}`, ownerToken: s.ownerToken, body: {} };
    const pairing = await request(s.url, options);
    assert.equal(pairing.status, 200, `${name} dashboard must be able to pair`);
    const enrolled = await request(s.url, { ...options, path: '/api/enroll', body: {
      code: pairing.json().code, name: 'Loopback fixture', platform: 'linux',
    } });
    assert.equal(enrolled.status, 200);
    const revoked = await request(s.url, { ...options, path: `/api/devices/${enrolled.json().deviceId}/revoke` });
    assert.equal(revoked.status, 200, `${name} dashboard must be able to revoke`);
  }
  for (const origin of [`http://localhost:${Number(port) + 1}`, `https://localhost:${port}`, 'https://evil.example']) {
    assert.equal((await request(s.url, { host: `localhost:${port}`, origin, ownerToken: s.ownerToken, body: {} })).status, 403);
  }
  assert.equal((await request(s.url, { host: `localhost:${port}`, origin: s.url, ownerToken: s.ownerToken, body: {} })).status, 403);
});

test('configured public origin does not inherit loopback aliases', async t => {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const s = await setup(t, { port, publicUrl: 'https://commander.test' });
  const localUrl = `http://127.0.0.1:${port}`;
  assert.equal((await request(localUrl, { host: 'commander.test', origin: 'https://commander.test', ownerToken: s.ownerToken, body: {} })).status, 200);
  assert.equal((await request(localUrl, { host: 'commander.test', origin: `http://localhost:${port}`, ownerToken: s.ownerToken, body: {} })).status, 403);
  assert.equal((await request(localUrl, { host: `localhost:${port}`, origin: `http://localhost:${port}`, ownerToken: s.ownerToken, body: {} })).status, 403);
});

test('rejected half-open upgrades release connection slots promptly', { timeout: 15000 }, async t => {
  const peers = [];
  t.after(() => { for (const peer of peers) peer.destroy(); });
  const s = await setup(t);
  const address = new URL(s.url);
  for (let i = 0; i < 280; i++) {
    const response = await new Promise((resolve, reject) => {
      const peer = net.connect({ host: address.hostname, port: Number(address.port), allowHalfOpen: true });
      peers.push(peer);
      let output = '';
      peer.setTimeout(1000, () => { peer.destroy(); reject(new Error('Rejected upgrade did not close promptly.')); });
      peer.once('error', reject);
      peer.on('data', chunk => { output += chunk.toString(); });
      peer.once('end', () => { peer.setTimeout(0); resolve(output); });
      peer.once('connect', () => peer.write(`GET /agent HTTP/1.1\r\nHost: ${address.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
    });
    assert.match(response, /^HTTP\/1\.1 (401|429) /, `Rejected connection ${i} must not exhaust server slots`);
  }
  assert.equal((await request(s.url, { path: '/health' })).status, 200);
});

async function childServer(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jrc-reset-'));
  const ownerToken = token();
  const source = `import { createControlServer } from ${JSON.stringify(new URL('../dist/self-host/server.js', import.meta.url).href)};
    const server = await createControlServer({ dataDir: process.env.JRC_TEST_DIR, ownerToken: process.env.JRC_TEST_TOKEN, port: 0 });
    process.send({ url: server.url });
    process.on('message', async message => { if (message === 'close') { await server.close(); process.exit(0); } });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, JRC_TEST_DIR: dataDir, JRC_TEST_TOKEN: ownerToken }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errorOutput = '';
  child.stderr.on('data', chunk => { errorOutput += chunk.toString(); });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; await rm(dataDir, { recursive: true, force: true }); });
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message),
    exited.then(() => { throw new Error(`Server fixture exited before readiness: ${errorOutput}`); }),
  ]);
  return { child, url: ready.url, exited, dataDir, ownerToken, errorOutput: () => errorOutput };
}

test('reset peers during rejected upgrades cannot crash the server', { timeout: 15000 }, async t => {
  const s = await childServer(t);
  const address = new URL(s.url);
  for (let batch = 0; batch < 5; batch++) {
    await Promise.all(Array.from({ length: 30 }, () => new Promise(resolve => {
      const peer = net.connect({ host: address.hostname, port: Number(address.port) });
      peer.on('error', () => {});
      peer.once('close', resolve);
      peer.once('connect', () => {
        peer.write(`GET /agent HTTP/1.1\r\nHost: ${address.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`, () => peer.resetAndDestroy());
      });
    })));
    assert.equal(s.child.exitCode, null, s.errorOutput());
  }
  assert.equal((await request(s.url, { path: '/health' })).status, 200, s.errorOutput());
});

test('a killed server releases its directory lock and preserves enrolled devices', { timeout: 15000 }, async t => {
  const s = await childServer(t);
  const options = { dataDir: s.dataDir, ownerToken: s.ownerToken, port: 0 };
  await assert.rejects(createControlServer(options), /locked/i, 'A running server must retain exclusive ownership');
  const pairing = await request(s.url, { ownerToken: s.ownerToken, body: {} });
  const enrolled = await request(s.url, { path: '/api/enroll', body: { code: pairing.json().code, name: 'Crash fixture', platform: 'linux' } });
  assert.equal(enrolled.status, 200);
  const deviceId = enrolled.json().deviceId;
  s.child.kill('SIGKILL');
  await s.exited;
  const restarted = await createControlServer(options);
  try {
    const devices = await request(restarted.url, { path: '/api/devices', ownerToken: s.ownerToken });
    assert.equal(devices.status, 200);
    assert.ok(devices.json().devices.some(device => device.id === deviceId && device.name === 'Crash fixture'));
  } finally { await restarted.close(); }
});

test('concurrent servers in the same process cannot share a data directory', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jrc-concurrent-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const options = { dataDir, ownerToken: token(), port: 0 };
  const results = await Promise.allSettled([createControlServer(options), createControlServer(options)]);
  try {
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(results.find(result => result.status === 'rejected').reason.message, /locked/i);
  } finally { for (const result of results) if (result.status === 'fulfilled') await result.value.close(); }
  const restarted = await createControlServer(options);
  await restarted.close();
});

test('simultaneous server processes elect only one directory owner', { timeout: 15000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jrc-process-race-'));
  const children = [];
  t.after(async () => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(children.map(({ exited }) => exited));
    await rm(dataDir, { recursive: true, force: true });
  });
  const source = `import { createControlServer } from ${JSON.stringify(new URL('../dist/self-host/server.js', import.meta.url).href)};
    process.send({ status: 'ready' });
    process.once('message', async () => {
      try {
        const server = await createControlServer({ dataDir: process.env.JRC_TEST_DIR, ownerToken: process.env.JRC_TEST_TOKEN, port: 0 });
        process.send({ status: 'started', url: server.url });
      } catch (error) { process.send({ status: 'rejected', locked: /locked/i.test(error.message) }); }
    });`;
  for (let i = 0; i < 2; i++) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, JRC_TEST_DIR: dataDir, JRC_TEST_TOKEN: token() }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const exited = once(child, 'exit');
    children.push({ child, exited });
    await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Race fixture exited before readiness.'); })]);
  }
  const outcomes = children.map(({ child, exited }) => Promise.race([
    once(child, 'message').then(([message]) => message),
    exited.then(() => { throw new Error('Race fixture exited before acquisition.'); }),
  ]));
  for (const { child } of children) child.send('start');
  const results = await Promise.all(outcomes);
  assert.equal(results.filter(result => result.status === 'started').length, 1);
  assert.equal(results.find(result => result.status === 'rejected')?.locked, true);
  assert.equal((await request(results.find(result => result.status === 'started').url, { path: '/health' })).status, 200);
});

test('a paused server retains its OS lock', { timeout: 15000, skip: process.platform === 'win32' }, async t => {
  const s = await childServer(t);
  s.child.kill('SIGSTOP');
  try {
    await assert.rejects(createControlServer({ dataDir: s.dataDir, ownerToken: s.ownerToken, port: 0 }), /locked/i);
  } finally { s.child.kill('SIGCONT'); }
  assert.equal((await request(s.url, { path: '/health' })).status, 200);
});

test('the lifetime lock uses DELETE mode without an uncommitted journal', async t => {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const dataDir = await mkdtemp(join(tmpdir(), 'jrc-lock-mode-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const path = join(dataDir, 'server-lock.sqlite');
  await writeFile(path, '', { mode: 0o600 });
  const seed = new DatabaseSync(path);
  seed.exec('PRAGMA journal_mode = WAL; CREATE TABLE fixture(value TEXT);');
  seed.close();
  const s = await createControlServer({ dataDir, ownerToken: token(), port: 0 });
  try { assert.ok(!(await readdir(dataDir)).includes('server-lock.sqlite-journal')); }
  finally { await s.close(); }
  // Inspect through SQLite only after the service has released its lock.
  const verify = new DatabaseSync(path);
  try { assert.equal(verify.prepare('PRAGMA journal_mode').get().journal_mode, 'delete'); }
  finally { verify.close(); }
});

test('legacy lock files require explicit recovery and are never stolen', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jrc-legacy-lock-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(join(dataDir, 'server.lock'), '999999999', { mode: 0o600 });
  await assert.rejects(createControlServer({ dataDir, ownerToken: token(), port: 0 }), /legacy/i);
  assert.equal(await readFile(join(dataDir, 'server.lock'), 'utf8'), '999999999');
  await writeFile(join(dataDir, 'server.lock'), 'unrecognized migration marker');
  await assert.rejects(createControlServer({ dataDir, ownerToken: token(), port: 0 }), /unrecognized/i);
  if (process.platform !== 'win32') {
    await rm(join(dataDir, 'server.lock'));
    await writeFile(join(dataDir, 'legacy-target'), 'untouched');
    await symlink(join(dataDir, 'legacy-target'), join(dataDir, 'server.lock'));
    await assert.rejects(createControlServer({ dataDir, ownerToken: token(), port: 0 }), /legacy/i);
    assert.equal(await readFile(join(dataDir, 'legacy-target'), 'utf8'), 'untouched');
  }
});

test('migrated directories keep legacy servers excluded while running and after shutdown', async t => {
  const s = await setup(t);
  const legacyOpen = () => assert.rejects(async () => {
    const handle = await open(join(s.dataDir, 'server.lock'), 'wx');
    await handle.close();
  }, { code: 'EEXIST' });
  await legacyOpen();
  await s.close();
  await legacyOpen();
  const restarted = await createControlServer({ dataDir: s.dataDir, ownerToken: s.ownerToken, port: 0 });
  await restarted.close();
});

test('nonregular SQLite lock state is rejected without touching its target', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jrc-bad-lock-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(join(dataDir, 'server-lock.sqlite'));
  const rejectsLock = () => assert.rejects(async () => {
    const unexpected = await createControlServer({ dataDir, ownerToken: token(), port: 0 });
    await unexpected.close();
  }, /lock/i);
  await rejectsLock();
  await rm(join(dataDir, 'server-lock.sqlite'), { recursive: true });
  // Windows symlink creation needs an additional privilege not granted on all hosts.
  if (process.platform !== 'win32') {
    const target = join(dataDir, 'target');
    await writeFile(target, 'untouched');
    await symlink(target, join(dataDir, 'server-lock.sqlite'));
    await rejectsLock();
    assert.equal(await readFile(target, 'utf8'), 'untouched');
  }
});

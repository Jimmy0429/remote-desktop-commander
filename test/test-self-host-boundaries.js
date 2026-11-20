import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createControlServer } from '../dist/self-host/server.js';

const tool = { name: 'read_file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const result = text => ({ content: [{ type: 'text', text }] });

async function eventually(fn) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await fn();
    if (value) return value;
    await delay(10);
  }
  assert.fail('Expected state did not arrive within the bounded wait');
}

async function setup(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jrc-boundaries-'));
  const ownerToken = randomBytes(32).toString('base64url');
  const sockets = [], clients = [];
  let server;
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const socket of sockets) socket.terminate();
    await server?.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  server = await createControlServer({ dataDir, ownerToken, port: 0, waitMs: 10, callTimeoutMs: 2000, ...options });
  const api = (path, body, credential = ownerToken) => fetch(server.url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function enroll(name = 'Test computer') {
    const pairingResponse = await api('/api/pairings', {});
    assert.equal(pairingResponse.status, 200);
    const pairing = await pairingResponse.json();
    const response = await api('/api/enroll', { code: pairing.code, name, platform: 'linux' }, '');
    assert.equal(response.status, 200);
    return { ...await response.json(), code: pairing.code };
  }
  async function connect(enrollment) {
    const socket = new WebSocket(server.url.replace(/^http/, 'ws') + '/agent', { headers: { Authorization: `Bearer ${enrollment.token}` } });
    sockets.push(socket);
    socket.on('error', () => {});
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const calls = [];
    socket.on('message', raw => calls.push(JSON.parse(raw.toString())));
    socket.send(JSON.stringify({ type: 'ready', tools: [tool] }));
    await eventually(async () => (await (await api('/api/devices')).json()).devices.some(d => d.id === enrollment.deviceId && d.online));
    return { ...enrollment, socket, calls };
  }
  async function client() {
    const client = new Client({ name: 'boundary-tests', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${ownerToken}` } } }));
    return client;
  }
  async function rejectedHandshake(credential) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(server.url.replace(/^http/, 'ws') + '/agent', { headers: { Authorization: `Bearer ${credential}` } });
      sockets.push(socket);
      socket.on('error', () => {});
      socket.once('unexpected-response', (_req, response) => { response.resume(); socket.terminate(); resolve(response.statusCode); });
      socket.once('open', () => { socket.terminate(); reject(new Error('Unauthorized WebSocket unexpectedly opened')); });
    });
  }
  return { ...server, api, enroll, connect, client, rejectedHandshake, dataDir, ownerToken };
}

const call = (client, deviceId, path = 'fixture') => client.callTool({ name: 'read_file', arguments: { deviceId, path } });
const poll = (client, callId) => client.callTool({ name: 'get_remote_call', arguments: { callId } });
const sendResult = (device, id, text) => device.socket.send(JSON.stringify({ type: 'result', id, result: result(text) }));
// A ping sent after a result makes its handling observable before the next assertion.
const receivedThrough = socket => new Promise((resolve, reject) => {
  socket.once('pong', resolve);
  socket.ping('boundary', error => { if (error) reject(error); });
});

test('owner and device credentials cannot be used interchangeably, and enrollment is single-use', { timeout: 10000 }, async t => {
  const s = await setup(t);
  assert.equal(await s.rejectedHandshake('invalid'), 401);
  assert.equal(await s.rejectedHandshake(s.ownerToken), 401);
  const enrollment = await s.enroll();
  assert.equal((await s.api('/api/enroll', { code: enrollment.code, name: 'Duplicate', platform: 'linux' }, '')).status, 400);
  assert.equal((await s.api('/api/pairings', {}, enrollment.token)).status, 401);
  assert.equal((await s.api('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, enrollment.token)).status, 401);
  const d = await s.connect(enrollment);
  const closed = new Promise(resolve => d.socket.once('close', resolve));
  assert.equal((await s.api(`/api/devices/${d.deviceId}/revoke`, {})).status, 200);
  await closed;
  assert.equal(await s.rejectedHandshake(d.token), 401);
});

test('a slow call can be polled after completion without submitting the operation again', { timeout: 10000 }, async t => {
  const s = await setup(t), d = await s.connect(await s.enroll()), c = await s.client();
  const pending = await call(c, d.deviceId);
  assert.equal(pending.structuredContent.status, 'running');
  const callId = pending.structuredContent.callId;
  await eventually(() => d.calls.length === 1);
  sendResult(d, callId, 'completed later');
  const completed = await eventually(async () => {
    const reply = await poll(c, callId);
    return reply.structuredContent.status === 'completed' && reply;
  });
  assert.equal(completed.structuredContent.result.content[0].text, 'completed later');
  assert.equal(d.calls.length, 1);
  const activity = (await (await s.api('/api/activity')).json()).activity;
  assert.equal(activity.length, 1);
  assert.equal(activity[0].status, 'completed');
});

test('result retention keeps a long call that finishes after 200 later short calls', { timeout: 120000 }, async t => {
  const s = await setup(t, { waitMs: 100, callTimeoutMs: 120000 });
  const d = await s.connect(await s.enroll());
  const c = await s.client();
  // Multiple results can finish in the same millisecond.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const pending = await call(c, d.deviceId, 'long');
  const longId = pending.structuredContent.callId;

  d.socket.on('message', raw => {
    const request = JSON.parse(raw);
    if (request.arguments.path === 'short') sendResult(d, request.id, 'short result');
  });
  for (let i = 0; i < 200; i++) {
    let reply = await call(c, d.deviceId, 'short');
    if (reply.structuredContent?.status === 'running') {
      const id = reply.structuredContent.callId;
      reply = await eventually(async () => (await poll(c, id)).structuredContent?.result);
    }
    assert.equal(reply.content[0].text, 'short result');
  }
  assert.equal((await poll(c, longId)).structuredContent.status, 'running');
  sendResult(d, longId, 'long result');
  await receivedThrough(d.socket);
  const completed = await poll(c, longId);
  assert.equal(completed.structuredContent?.result.content[0].text, 'long result');
  assert.equal((await poll(c, d.calls[1].id)).isError, true, 'evict the oldest completion');
  assert.equal((await poll(c, d.calls[2].id)).structuredContent.status, 'completed');
  assert.equal(d.calls.length, 201, 'collecting retained results does not dispatch another call');
});

test('retention discards expired results before enforcing its serialized byte budget', { timeout: 120000 }, async t => {
  const s = await setup(t, { waitMs: 1, callTimeoutMs: 120000 });
  const d = await s.connect(await s.enroll());
  const c = await s.client();
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });

  const text = '🌱'.repeat(900_000);
  const resultBytes = Buffer.byteLength(JSON.stringify(result(text)));
  const capacity = Math.floor((64 * 1024 * 1024) / resultBytes);
  const ids = [];
  for (let index = 0; index <= capacity; index++) {
    const pending = await call(c, d.deviceId);
    ids.push(pending.structuredContent.callId);
    // A backward wall-clock adjustment can make a later completion expire first.
    if (index === 1) t.mock.timers.setTime(now - 600_000);
    if (index === capacity) t.mock.timers.setTime(now + 1);
    sendResult(d, ids[index], text);
    await receivedThrough(d.socket);
    if (index === 1) t.mock.timers.setTime(now);
  }
  assert.equal((await poll(c, ids[1])).isError, true);
  assert.equal((await poll(c, ids[0])).structuredContent?.status, 'completed', 'expired bytes cannot evict a fresh result');

  const extra = await call(c, d.deviceId);
  sendResult(d, extra.structuredContent.callId, text);
  await receivedThrough(d.socket);
  assert.equal((await poll(c, ids[0])).isError, true, 'evict the oldest live result when the byte budget is exceeded');
  assert.equal((await poll(c, ids[2])).structuredContent?.status, 'completed');
});

test('another authenticated device cannot supply a result for the selected device', { timeout: 10000 }, async t => {
  const s = await setup(t), a = await s.connect(await s.enroll('A')), b = await s.connect(await s.enroll('B')), c = await s.client();
  const pending = await call(c, a.deviceId);
  const id = pending.structuredContent.callId;
  sendResult(b, id, 'wrong device');
  await receivedThrough(b.socket);
  assert.equal((await poll(c, id)).structuredContent.status, 'running');
  sendResult(a, id, 'right device');
  const completed = await eventually(async () => {
    const reply = await poll(c, id);
    return reply.structuredContent.status === 'completed' && reply;
  });
  assert.equal(completed.structuredContent.result.content[0].text, 'right device');
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 0);
});

test('reconnecting a device makes its old in-flight call unknown and rejects late-generation results', { timeout: 10000 }, async t => {
  const s = await setup(t), enrollment = await s.enroll(), old = await s.connect(enrollment), c = await s.client();
  const pending = await call(c, old.deviceId);
  const id = pending.structuredContent.callId;
  const replacement = await s.connect(enrollment);
  sendResult(replacement, id, 'late replacement result');
  await receivedThrough(replacement.socket);
  const polled = await poll(c, id);
  assert.equal(polled.structuredContent.status, 'unknown');
  assert.equal(polled.isError, true);
  assert.equal(old.calls.length, 1);
  assert.equal(replacement.calls.length, 0);
});

test('timed-out execution remains unknown when a late response arrives and is never replayed', { timeout: 10000 }, async t => {
  const s = await setup(t, { callTimeoutMs: 120 }), d = await s.connect(await s.enroll()), c = await s.client();
  const pending = await call(c, d.deviceId);
  const id = pending.structuredContent.callId;
  const timedOut = await eventually(async () => {
    const reply = await poll(c, id);
    return reply.structuredContent.status === 'unknown' && reply;
  });
  assert.equal(timedOut.isError, true);
  sendResult(d, id, 'too late');
  await receivedThrough(d.socket);
  assert.equal((await poll(c, id)).structuredContent.status, 'unknown');
  assert.equal(d.calls.length, 1);
});

test('an explicit offline selector never falls back to another connected computer', { timeout: 10000 }, async t => {
  const s = await setup(t), offline = await s.enroll('Offline'), online = await s.connect(await s.enroll('Online')), c = await s.client();
  const response = await call(c, offline.deviceId);
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /offline|revoked/i);
  assert.equal(online.calls.length, 0);
});

test('malformed and oversized HTTP and WebSocket messages are rejected while the server remains available', { timeout: 10000 }, async t => {
  const s = await setup(t);
  const malformed = await fetch(s.url + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const oversized = await fetch(s.url + '/api/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(4 * 1024 * 1024 + 1) });
  assert.equal(oversized.status, 413);
  for (const payload of ['{', 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    const d = await s.connect(await s.enroll());
    const closed = new Promise(resolve => d.socket.once('close', code => resolve(code)));
    d.socket.send(payload);
    // A payload-limit failure may terminate before the close frame is flushed.
    assert.ok([1006, 1008, 1009].includes(await closed));
    await eventually(async () => !(await (await s.api('/api/devices')).json()).devices.find(device => device.id === d.deviceId).online);
  }
  assert.equal((await fetch(s.url + '/health')).status, 200);
});

test('a second server cannot use the same state directory and its failed start does not disrupt the first', { timeout: 10000 }, async t => {
  const s = await setup(t);
  await assert.rejects(createControlServer({ dataDir: s.dataDir, ownerToken: s.ownerToken, port: 0 }), /locked/i);
  assert.equal((await s.api('/api/devices')).status, 200);
  await s.close();
  const replacement = await createControlServer({ dataDir: s.dataDir, ownerToken: s.ownerToken, port: 0 });
  try { assert.equal((await fetch(replacement.url + '/health')).status, 200); }
  finally { await replacement.close(); }
});

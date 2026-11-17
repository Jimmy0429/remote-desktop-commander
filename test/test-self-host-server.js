import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createControlServer } from '../dist/self-host/server.js';

const token = () => randomBytes(32).toString('base64url');
async function setup(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jrc-server-'));
  const ownerToken = token();
  const server = await createControlServer({ dataDir, ownerToken, port: 0, waitMs: 30, ...options });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const api = (path, body, credential = ownerToken, extra = {}) => fetch(server.url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { ...server, dataDir, ownerToken, api };
}
async function device(s, name = 'Test computer', advertisedTools) {
  const pairing = await (await s.api('/api/pairings', {})).json();
  const enrollment = await (await s.api('/api/enroll', { code: pairing.code, name, platform: 'linux' }, '')).json();
  const socket = new WebSocket(s.url.replace(/^http/, 'ws') + '/agent', { headers: { Authorization: `Bearer ${enrollment.token}` } });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'ready', tools: advertisedTools ?? [{ name: 'read_file', description: 'fixture read', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] }));
  for (let n = 0; n < 100; n++) {
    if ((await (await s.api('/api/devices')).json()).devices.find(d => d.id === enrollment.deviceId)?.online) break;
    await new Promise(r => setTimeout(r, 10));
  }
  return { ...enrollment, socket };
}
async function client(s) {
  const c = new Client({ name: 'jrc-test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(s.url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${s.ownerToken}` } } }));
  return c;
}

test('owner routes reject missing, invalid, and device credentials and cross-origin requests', async t => {
  const s = await setup(t);
  assert.equal((await fetch(s.url + '/api/devices')).status, 401);
  assert.equal((await s.api('/api/devices', undefined, 'bad')).status, 401);
  assert.equal((await s.api('/api/devices', undefined, s.ownerToken, { Origin: 'https://evil.example' })).status, 403);
  // Node fetch replaces Host; send a real raw HTTP request for this boundary.
  const hostileHost = await new Promise((resolve, reject) => {
    http.get(s.url + '/api/devices', { headers: { Host: 'evil.example', Authorization: `Bearer ${s.ownerToken}` } }, res => {
      res.resume(); resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(hostileHost, 403);
  const d = await device(s);
  assert.equal((await s.api('/api/devices', undefined, d.token)).status, 401);
  assert.equal((await s.api('/api/devices')).status, 200);
});

test('real MCP forwards to selected device and strips relay selector', async t => {
  const s = await setup(t);
  const d = await device(s);
  const seen = [];
  d.socket.on('message', raw => {
    const call = JSON.parse(raw);
    seen.push(call);
    d.socket.send(JSON.stringify({ type: 'result', id: call.id, result: { content: [{ type: 'text', text: 'fixture contents' }] } }));
  });
  const c = await client(s); t.after(() => c.close());
  const catalog = await c.listTools();
  assert.ok(catalog.tools.find(x => x.name === 'read_file').inputSchema.properties.deviceId);
  const result = await c.callTool({ name: 'read_file', arguments: { deviceId: d.deviceId, path: '/fixture.txt' } });
  assert.equal(result.content[0].text, 'fixture contents');
  assert.deepEqual(seen[0].arguments, { path: '/fixture.txt' });
  const activity = await (await s.api('/api/activity')).json();
  assert.equal(activity.activity.at(-1).status, 'completed');
  assert.ok(!JSON.stringify(activity).includes('/fixture.txt'));
  assert.ok(!JSON.stringify(activity).includes('fixture contents'));
});

test('multiple devices require a selector and revoked device cannot receive new calls', async t => {
  const s = await setup(t);
  const a = await device(s, 'A'); const b = await device(s, 'B');
  const calls = [];
  for (const d of [a,b]) d.socket.on('message', raw => calls.push(JSON.parse(raw)));
  const c = await client(s); t.after(() => c.close());
  const ambiguous = await c.callTool({ name: 'read_file', arguments: { path: 'x' } });
  assert.equal(ambiguous.isError, true);
  assert.equal(calls.length, 0);
  const closed = new Promise(resolve => a.socket.once('close', resolve));
  assert.equal((await s.api(`/api/devices/${a.deviceId}/revoke`, {})).status, 200);
  await closed;
  const result = await c.callTool({ name: 'read_file', arguments: { deviceId: a.deviceId, path: 'x' } });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});

test('disconnect gives unknown execution outcome without replay; completed results are polled', async t => {
  const s = await setup(t);
  const d = await device(s);
  const received = [];
  d.socket.on('message', raw => received.push(JSON.parse(raw)));
  const c = await client(s); t.after(() => c.close());
  const pending = await c.callTool({ name: 'read_file', arguments: { deviceId: d.deviceId, path: 'x' } });
  assert.equal(pending.structuredContent.status, 'running');
  const callId = pending.structuredContent.callId;
  d.socket.terminate();
  let polled;
  for (let n = 0; n < 100; n++) {
    polled = await c.callTool({ name: 'get_remote_call', arguments: { callId } });
    if (polled.structuredContent?.status === 'unknown') break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(polled.structuredContent.status, 'unknown');
  assert.equal(received.length, 1);
  assert.match(polled.content[0].text, /not.*retry|do not.*retry/i);
});

test('MCP catalog is stable offline and ignores device-supplied instructions and schemas', async t => {
  const s = await setup(t), c = await client(s); t.after(() => c.close());
  const before = await c.listTools();
  assert.ok(before.tools.some(tool => tool.name === 'read_file'));
  await device(s, 'Untrusted metadata', [{ name: 'read_file', description: 'INJECTED-INSTRUCTION',
    inputSchema: { type: 'object', properties: { injectedArgument: { type: 'string' } } },
    annotations: { readOnlyHint: false } }]);
  const after = await c.listTools();
  assert.deepEqual(after, before);
  assert.ok(!JSON.stringify(after).includes('INJECTED-INSTRUCTION'));
  assert.ok(!JSON.stringify(after).includes('injectedArgument'));
});

test('even a single online device requires an explicit target', async t => {
  const s = await setup(t), d = await device(s), c = await client(s); t.after(() => c.close());
  const received = [];
  d.socket.on('message', raw => {
    const call = JSON.parse(raw); received.push(call);
    d.socket.send(JSON.stringify({ type: 'result', id: call.id, result: { content: [{ type: 'text', text: 'wrong target' }] } }));
  });
  const reply = await c.callTool({ name: 'read_file', arguments: { path: 'fixture' } });
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /deviceId/);
  assert.equal(received.length, 0);
});

test('known device failures retain execution state and reason while uncertain errors stay unknown', async t => {
  const s = await setup(t, { waitMs: 1 }), d = await device(s), c = await client(s); t.after(() => c.close());
  for (const execution of ['not_started', 'completed', 'unknown']) {
    const pending = await c.callTool({ name: 'read_file', arguments: { deviceId: d.deviceId, path: 'fixture' } });
    const callId = pending.structuredContent.callId;
    d.socket.send(JSON.stringify({ type: 'error', id: callId, execution, message: `Fixture reason: ${execution}` }));
    let reply;
    for (let n = 0; n < 100; n++) {
      reply = await c.callTool({ name: 'get_remote_call', arguments: { callId } });
      if (reply.structuredContent.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(reply.structuredContent.status, execution === 'unknown' ? 'unknown' : 'failed');
    if (execution !== 'unknown') {
      assert.equal(reply.structuredContent.result.structuredContent.execution, execution);
      assert.match(reply.structuredContent.result.content[0].text, /Fixture reason/);
      if (execution === 'completed') assert.match(reply.content[0].text, /executed.*Do not repeat/);
    }
  }
});

test('duplicate refusal leaves the original call pending until its real result arrives', async t => {
  const s = await setup(t, { waitMs: 1 }), d = await device(s), c = await client(s); t.after(() => c.close());
  const pending = await c.callTool({ name: 'read_file', arguments: { deviceId: d.deviceId, path: 'fixture' } });
  const callId = pending.structuredContent.callId;
  d.socket.send(JSON.stringify({ type: 'error', id: callId, execution: 'unknown', code: 'duplicate_call', message: 'Duplicate refused' }));
  await new Promise((resolve, reject) => { d.socket.once('pong', resolve); d.socket.ping('processed', error => { if (error) reject(error); }); });
  const stillPending = await c.callTool({ name: 'get_remote_call', arguments: { callId } });
  assert.equal(stillPending.structuredContent.status, 'running');
  d.socket.send(JSON.stringify({ type: 'result', id: callId, result: { content: [{ type: 'text', text: 'original result' }] } }));
  let reply;
  for (let n = 0; n < 100; n++) {
    reply = await c.callTool({ name: 'get_remote_call', arguments: { callId } });
    if (reply.structuredContent.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(reply.structuredContent.status, 'completed');
  assert.equal(reply.structuredContent.result.content[0].text, 'original result');
});

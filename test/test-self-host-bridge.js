import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createControlServer } from '../dist/self-host/server.js';
import { startAgent } from '../dist/self-host/agent.js';
import { MAX_MESSAGE_BYTES } from '../dist/self-host/protocol.js';
import { writePrivateFile } from '../dist/self-host/private-storage.js';

const bridgeUrl = new URL('../dist/self-host/bridge.js', import.meta.url).href;
const token = () => randomBytes(32).toString('base64url');

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'jrc-bridge-')));
  const workspace = join(base, 'workspace with spaces é');
  await mkdir(workspace);
  const tokenFile = join(base, 'private credentials', 'owner-token');
  const ownerToken = token();
  writePrivateFile(tokenFile, ownerToken);
  const entry = join(base, 'bridge entry é.mjs');
  await writeFile(entry, `
    import { readFile } from 'node:fs/promises';
    import { startStdioBridge } from ${JSON.stringify(bridgeUrl)};
    try {
      const bridge = await startStdioBridge({ serverUrl: process.argv[2], ownerToken: (await readFile(process.argv[3], 'utf8')).trim() });
      const exit = await bridge.closed;
      process.stderr.write('BRIDGE_CLOSED:' + exit.exitCode + '\\n');
      process.exitCode = exit.exitCode;
    } catch (error) {
      process.stderr.write(error.message + '\\n');
      process.exitCode = 1;
    }
  `);
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    await rm(base, { recursive: true, force: true });
  });
  return { base, workspace, tokenFile, ownerToken, entry, cleanup };
}

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function connectBridge(t, f, serverUrl, { allowFailure = false, useCli = false } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: useCli
      ? [fileURLToPath(new URL('../dist/self-host/cli.js', import.meta.url)), 'bridge', '--server', serverUrl, '--token-file', f.tokenFile]
      : [f.entry, serverUrl, f.tokenFile], stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', data => { stderr += data.toString(); });
  const client = new Client({ name: 'bridge-integration-test', version: '1' });
  const errors = [];
  client.onerror = error => errors.push(error);
  f.cleanup.push(() => client.close());
  const connected = client.connect(transport, { timeout: 10000 });
  if (allowFailure) await connected.catch(() => {});
  else await connected;
  return { client, transport, errors, stderr: () => stderr };
}

async function settledCall(client, name, args) {
  let result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10000 });
  const callId = result.structuredContent?.callId;
  if (callId) {
    const deadline = Date.now() + 15000;
    while (result.structuredContent?.status === 'running') {
      assert.ok(Date.now() < deadline, 'Remote result polling exceeded its deadline.');
      await delay(25);
      result = await client.callTool({ name: 'get_remote_call', arguments: { callId } }, undefined, { timeout: 5000 });
      assert.equal(result.structuredContent.callId, callId);
    }
    assert.equal(result.structuredContent.status, 'completed', JSON.stringify(result));
    result = result.structuredContent.result;
  }
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return { result, callId };
}

test('stdio bridge preserves tools and async results through a real server and agent, without replaying a lost response', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  const server = await createControlServer({ dataDir: join(f.base, 'server'), ownerToken: f.ownerToken, port: 0, waitMs: 1 });
  f.cleanup.push(() => server.close());
  const api = async (path, body) => (await fetch(server.url + path, {
    method: 'POST', headers: { Authorization: `Bearer ${f.ownerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  const pairing = await api('/api/pairings', {});
  const enrollment = await api('/api/enroll', { code: pairing.code, name: 'Bridge fixture', platform: process.platform });
  const agent = await startAgent({ serverUrl: server.url, deviceToken: enrollment.token, workspace: f.workspace, stateDir: join(f.base, 'engine') });
  f.cleanup.push(() => agent.close());
  let dropNextAppend = false;
  let appendDispatches = 0;
  let holdReads = false;
  let forwardedCalls = 0;
  const proxy = await listen(t, async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const message = body ? JSON.parse(body) : undefined;
      if (message?.method === 'tools/call') forwardedCalls++;
      if (holdReads && message?.params?.name === 'read_file') await delay(100);
      const isAppend = message?.method === 'tools/call' && message.params.name === 'write_file' && message.params.arguments.mode === 'append';
      if (isAppend) appendDispatches++;
      const response = await fetch(server.url + '/mcp', {
        method: req.method, headers: {
          Authorization: req.headers.authorization || '', 'Content-Type': 'application/json',
          Accept: req.headers.accept || 'application/json, text/event-stream',
          ...(req.headers['mcp-protocol-version'] ? { 'MCP-Protocol-Version': req.headers['mcp-protocol-version'] } : {}),
        }, ...(body ? { body } : {}),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (isAppend && dropNextAppend) { dropNextAppend = false; res.destroy(); return; }
      res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json' });
      res.end(bytes);
    } catch { res.destroy(); }
  });
  const bridge = await connectBridge(t, f, proxy.url, { useCli: true });
  const tools = await bridge.client.listTools();
  const direct = new Client({ name: 'bridge-parity-test', version: '1' });
  f.cleanup.push(() => direct.close());
  await direct.connect(new StreamableHTTPClientTransport(new URL(server.url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${f.ownerToken}` } } }));
  assert.deepEqual(tools, await direct.listTools());
  const devices = await bridge.client.callTool({ name: 'list_devices', arguments: {} });
  assert.ok(devices.structuredContent.devices.some(d => d.id === enrollment.deviceId && d.online));
  const missingSelector = await bridge.client.callTool({ name: 'read_file', arguments: { path: 'not forwarded' } });
  assert.equal(missingSelector.isError, true);
  const args = extra => ({ deviceId: enrollment.deviceId, ...extra });
  const file = join(f.workspace, 'bridge round trip.txt');
  await settledCall(bridge.client, 'write_file', args({ path: file, content: 'BRIDGE_FILE_MARKER\n' }));
  assert.equal(await readFile(file, 'utf8'), 'BRIDGE_FILE_MARKER\n');
  assert.match(JSON.stringify((await settledCall(bridge.client, 'read_file', args({ path: file }))).result), /BRIDGE_FILE_MARKER/);
  const search = (await settledCall(bridge.client, 'start_search', args({ path: f.workspace, pattern: 'BRIDGE_FILE_MARKER', searchType: 'content', literalSearch: true }))).result;
  const sessionId = JSON.stringify(search).match(/session: (search_[A-Za-z0-9_]+)/)?.[1];
  assert.ok(sessionId, JSON.stringify(search));
  let results;
  const deadline = Date.now() + 10000;
  do {
    results = (await settledCall(bridge.client, 'get_more_search_results', args({ sessionId, offset: 0, length: 20 }))).result;
    if (!JSON.stringify(results).includes('COMPLETED')) await delay(25);
  } while (!JSON.stringify(results).includes('COMPLETED') && Date.now() < deadline);
  assert.match(JSON.stringify(results), /bridge round trip\.txt/);
  // A slow operation deterministically returns a retained call ID through stdio.
  const worker = join(f.workspace, 'slow worker.cjs');
  await writeFile(worker, "setTimeout(()=>console.log('BRIDGE_PROCESS_MARKER'),1000)");
  const quote = process.platform === 'win32' ? value => "'" + value.replaceAll("'", "''") + "'" : value => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = (process.platform === 'win32' ? '& ' : '') + quote(process.execPath) + ' ' + quote(worker);
  const processResult = await settledCall(bridge.client, 'start_process', args({ command, timeout_ms: 3000, ...(process.platform === 'win32' ? { shell: 'powershell.exe' } : {}) }));
  assert.ok(processResult.callId, 'Slow operation must expose the remote call ID without resubmission.');
  assert.match(JSON.stringify(processResult.result), /BRIDGE_PROCESS_MARKER/);
  assert.equal(bridge.errors.length, 0, 'Stdout must contain protocol messages only.');
  const beforeOversize = forwardedCalls;
  await assert.rejects(bridge.client.callTool({ name: 'write_file', arguments: args({ path: file, content: 'x'.repeat(MAX_MESSAGE_BYTES) }) }), /too large.*not forwarded/i);
  assert.equal(forwardedCalls, beforeOversize);
  holdReads = true;
  const beforeBurst = forwardedCalls;
  const burst = await Promise.allSettled(Array.from({ length: 9 }, () => bridge.client.callTool({ name: 'read_file', arguments: args({ path: file }) })));
  holdReads = false;
  assert.equal(burst.filter(result => result.status === 'fulfilled').length, 8);
  assert.equal(forwardedCalls - beforeBurst, 8);
  assert.match(String(burst.find(result => result.status === 'rejected').reason), /Too many active requests.*not forwarded/i);
  dropNextAppend = true;
  await assert.rejects(bridge.client.callTool({ name: 'write_file', arguments: args({ path: file, content: 'ONCE_ONLY\n', mode: 'append' }) }, undefined, { timeout: 5000 }), /may have executed.*inspect.*retry/i);
  await delay(300);
  assert.equal(appendDispatches, 1);
  assert.equal(await readFile(file, 'utf8'), 'BRIDGE_FILE_MARKER\nONCE_ONLY\n');
  assert.ok(!bridge.stderr().includes(f.ownerToken));
  assert.match(bridge.stderr(), /may have executed|unknown/i);
  assert.match(JSON.stringify((await settledCall(bridge.client, 'read_file', args({ path: file }))).result), /ONCE_ONLY/);
  assert.equal(appendDispatches, 1, 'Explicit state inspection must not replay the failed append.');
});

test('bridge rejects authentication failures, redirects and non-loopback HTTP without exposing credentials', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  let redirectedRequests = 0;
  const target = await listen(t, (_req, res) => { redirectedRequests++; res.end('{}'); });
  for (const status of [401, 403, 302, 307]) {
    let requests = 0;
    const endpoint = await listen(t, (_req, res) => {
      requests++;
      res.writeHead(status, { Location: target.url + '/mcp', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'untrusted response ' + f.ownerToken }));
    });
    const bridge = await connectBridge(t, f, endpoint.url, { allowFailure: true });
    await assert.rejects(bridge.client.listTools(undefined, { timeout: 3000 }));
    await bridge.client.close();
    assert.ok(requests > 0, 'The actual bridge must attempt authentication.');
    assert.ok(!bridge.stderr().includes(f.ownerToken));
    assert.ok(!bridge.stderr().includes('untrusted response'));
    assert.equal(bridge.errors.length, 0, 'Rejected authentication must not put error text on stdout.');
  }
  assert.equal(redirectedRequests, 0, 'Bearer credentials must never follow a redirect.');
  const invalid = await connectBridge(t, f, 'http://example.com', { allowFailure: true });
  await assert.rejects(invalid.client.listTools(undefined, { timeout: 3000 }));
  assert.ok(!invalid.stderr().includes(f.ownerToken));
});

test('bridge bounds HTTP responses and shuts down on stdin EOF without protocol noise', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const huge = await listen(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('x'.repeat(5 * 1024 * 1024)); });
  const failed = await connectBridge(t, f, huge.url, { allowFailure: true });
  await assert.rejects(failed.client.listTools(undefined, { timeout: 3000 }));
  await failed.client.close();
  assert.ok(!failed.stderr().includes(f.ownerToken));
  assert.ok(failed.stderr().length < 2048);
  assert.equal(failed.errors.length, 0, 'Oversized remote output must not corrupt local stdout.');
  const server = await createControlServer({ dataDir: join(f.base, 'eof-server'), ownerToken: f.ownerToken, port: 0 });
  f.cleanup.push(() => server.close());
  const child = spawn(process.execPath, [f.entry, server.url, f.tokenFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const exited = once(child, 'exit');
  child.stdin.end();
  const result = await Promise.race([exited, delay(3000).then(() => { throw new Error('Bridge did not exit on stdin EOF.'); })]);
  assert.equal(result[0], 0, stderr);
  assert.equal(stdout, '', 'EOF before a request must not emit logs or unsolicited replies.');
  assert.match(stderr, /BRIDGE_CLOSED:0/);
  assert.ok(!stderr.includes(f.ownerToken));
});

test('Windows desktop launch initializes a detached CLI bridge over pipes and exits on EOF', {
  skip: process.platform !== 'win32', timeout: 45000,
}, async t => {
  const f = await fixture(t);
  const server = await createControlServer({ dataDir: join(f.base, 'detached-server'), ownerToken: f.ownerToken, port: 0 });
  f.cleanup.push(() => server.close());
  // The SDK sets windowsHide but cannot request detached. Use native spawn to
  // exercise the desktop launch condition without an inherited console.
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('../dist/self-host/cli.js', import.meta.url)),
    'bridge', '--server', server.url, '--token-file', f.tokenFile,
  ], { detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: f.workspace });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  // Observe rejection immediately even if spawn fails before the first request.
  void closed.catch(() => {});
  f.cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed.catch(() => {});
  });
  let stderr = '';
  let partial = '';
  let stdoutBytes = 0;
  let protocolFailure;
  const messages = [];
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdin.on('error', () => { protocolFailure = 'Detached bridge closed stdin before completing the protocol.'; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > MAX_MESSAGE_BYTES) { protocolFailure = 'Detached bridge stdout exceeded its bound.'; child.kill(); return; }
    partial += chunk;
    let newline;
    while ((newline = partial.indexOf('\n')) !== -1) {
      const line = partial.slice(0, newline);
      partial = partial.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (message.jsonrpc !== '2.0') throw new Error();
        messages.push(message);
      } catch { protocolFailure = 'Detached bridge wrote non-protocol text to stdout.'; }
    }
  });
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const reply = async id => {
    const deadline = Date.now() + 15000;
    while (!messages.some(message => message.id === id)) {
      assert.equal(protocolFailure, undefined);
      assert.ok(child.exitCode === null && child.signalCode === null, 'Detached bridge exited before replying.');
      assert.ok(Date.now() < deadline, 'Detached bridge did not reply within its deadline.');
      await delay(20);
    }
    const message = messages.find(candidate => candidate.id === id);
    assert.equal(message.error, undefined, 'Detached bridge returned an MCP error.');
    return message.result;
  };
  send({ id: 1, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'windows-detached-probe', version: '1' },
  } });
  assert.ok((await reply(1)).capabilities.tools);
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list', params: {} });
  const catalog = await reply(2);
  assert.ok(catalog.tools.some(tool => tool.name === 'read_file' && tool.inputSchema.required.includes('deviceId')));
  send({ id: 3, method: 'tools/call', params: { name: 'list_devices', arguments: {} } });
  assert.deepEqual((await reply(3)).structuredContent.devices, []);
  child.stdin.end();
  const exit = await Promise.race([closed, delay(5000).then(() => { throw new Error('Detached bridge did not exit after EOF.'); })]);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(protocolFailure, undefined);
  assert.equal(partial, '');
  assert.deepEqual(messages.map(message => message.id), [1, 2, 3], 'Initialized notification must not receive a reply.');
  assert.ok(!stderr.includes(f.ownerToken), 'Detached launch must not expose its credential.');
});

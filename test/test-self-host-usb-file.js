import assert from 'node:assert/strict';
import { once } from 'node:events';
import { link, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { startAgent } from '../dist/self-host/agent.js';
import { ensurePrivateDirectory } from '../dist/self-host/private-storage.js';

test('USB device advertises and serves only its freshly created text file', { timeout: 45000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jrc-usb-file-')));
  const workspace = join(root, 'pilot space');
  const file = join(workspace, 'pilot-check.txt');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  const connected = once(server, 'connection').then(async ([socket]) => {
    const [wire] = await once(socket, 'message');
    return { socket, ready: JSON.parse(wire.toString()) };
  });
  let agent;
  try {
    ensurePrivateDirectory(workspace);
    const options = { workspace, stateDir: join(root, 'state'), portablePilotFile: file, serverUrl: url, deviceToken: 'usb-fixture' };
    agent = await startAgent(options);
    const { socket, ready } = await connected;
    assert.equal(ready.type, 'ready');
    assert.deepEqual(ready.tools.map(tool => tool.name).sort(), ['read_file', 'write_file']);
    let count = 0;
    async function call(name, args) {
      const id = 'usb-' + ++count;
      const next = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'call', id, name, arguments: args }));
      const [wire] = await next;
      const response = JSON.parse(wire.toString());
      assert.equal(response.id, id);
      return response;
    }
    async function refused(name, args) {
      const reply = await call(name, args);
      assert.equal(reply.type, 'error');
      assert.equal(reply.execution, 'not_started');
    }
    const sample = 'USB pilot — one file\n';
    assert.equal((await call('write_file', { path: file, content: sample })).type, 'result');
    assert.equal(await readFile(file, 'utf8'), sample);
    const reply = await call('read_file', { path: 'pilot-check.txt' });
    assert.equal(reply.result.content[0].text, sample);
    await refused('list_directory', { path: workspace });
    await refused('start_process', {});
    await refused('read_file', { path: 'another.txt' });
    await refused('read_file', { path: file, isUrl: true });
    await refused('write_file', { path: file, content: 'x'.repeat(65537) });
    assert.equal(await readFile(file, 'utf8'), sample);
    const alias = join(root, 'normal-hard-link.txt');
    await link(file, alias);
    await refused('write_file', { path: file, content: 'another value' });
    assert.equal(await readFile(alias, 'utf8'), sample);
    await unlink(alias);
    assert.equal((await call('write_file', { path: file, content: 'short' })).type, 'result');
    assert.equal((await call('write_file', { path: file, content: '\nline two', mode: 'append' })).type, 'result');
    assert.equal((await call('read_file', { path: file, offset: -1, length: 1 })).result.content[0].text, 'line two');
    assert.equal(await readFile(file, 'utf8'), 'short\nline two');
    const moved = join(workspace, 'moved.txt');
    await rename(file, moved);
    await writeFile(file, 'replacement fixture');
    await refused('read_file', { path: file });
    await refused('write_file', { path: file, content: 'new' });
    assert.equal(await readFile(file, 'utf8'), 'replacement fixture');
    assert.equal(await readFile(moved, 'utf8'), 'short\nline two');
    await agent.close();
    agent = undefined;
    // A second launch must choose a new workspace rather than claim an existing file.
    await writeFile(file, 'preexisting fixture');
    await assert.rejects(startAgent(options), /file|workspace|engine/i);
    assert.equal(await readFile(file, 'utf8'), 'preexisting fixture');
  } finally {
    await agent?.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

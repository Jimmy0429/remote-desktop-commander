import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalEngine } from '../dist/self-host/local-engine.js';
import { MAX_MESSAGE_BYTES } from '../dist/self-host/protocol.js';

test('oversized file result does not disconnect the engine or stop an existing terminal worker', { timeout: 40000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'jrc-output-limit-')));
  const workspace = join(base, 'workspace');
  await mkdir(workspace);
  const engine = new LocalEngine({ workspace, stateDir: join(base, 'state') });
  let workerPid;
  let disconnected = false;
  engine.onDisconnect(() => { disconnected = true; });
  try {
    await engine.start();
    const workerFile = join(workspace, 'output worker.cjs');
    await writeFile(workerFile, "console.log('WORKER-PID:'+process.pid);setInterval(()=>console.log('WORKER_ALIVE'),500)");
    const quote = process.platform === 'win32'
      ? value => "'" + value.replaceAll("'", "''") + "'"
      : value => "'" + value.replaceAll("'", "'\\''") + "'";
    const command = (process.platform === 'win32' ? '& ' : '') + quote(process.execPath) + ' ' + quote(workerFile);
    const started = await engine.call('start_process', { command, timeout_ms: 300, ...(process.platform === 'win32' ? { shell: 'powershell.exe' } : {}) });
    assert.notEqual(started.isError, true, JSON.stringify(started));
    const sessionMatch = /Process started with PID (\d+)/.exec(JSON.stringify(started));
    assert.ok(sessionMatch, JSON.stringify(started));
    const sessionPid = Number(sessionMatch[1]);
    let observed = JSON.stringify(started);
    let workerMatch = /WORKER-PID:(\d+)/.exec(observed);
    const deadline = Date.now() + 10000;
    while (!workerMatch && Date.now() < deadline) {
      observed += JSON.stringify(await engine.call('read_process_output', { pid: sessionPid, timeout_ms: 250 }));
      workerMatch = /WORKER-PID:(\d+)/.exec(observed);
    }
    assert.ok(workerMatch, 'Terminal worker did not become ready.');
    workerPid = Number(workerMatch[1]);
    const largeFile = join(workspace, 'large-line.txt');
    const smallFile = join(workspace, 'small.txt');
    await writeFile(largeFile, 'x'.repeat(5 * 1024 * 1024));
    await writeFile(smallFile, 'ENGINE_STILL_READY');
    const result = await engine.call('read_file', { path: largeFile, length: 1 });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { execution: 'completed', errorCode: 'result_too_large' });
    assert.match(JSON.stringify(result.content), /operation executed.*result.*too large/i);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < MAX_MESSAGE_BYTES - 1024);
    assert.equal(disconnected, false, 'Oversized output must not close the engine.');
    process.kill(workerPid, 0);
    const next = await engine.call('read_file', { path: smallFile });
    assert.notEqual(next.isError, true);
    assert.match(JSON.stringify(next), /ENGINE_STILL_READY/);
    let workerOutput = '';
    const outputDeadline = Date.now() + 5000;
    do {
      const output = await engine.call('read_process_output', { pid: sessionPid, timeout_ms: 1000, offset: 0, length: 100 });
      assert.notEqual(output.isError, true, JSON.stringify(output));
      workerOutput += JSON.stringify(output);
      if (!workerOutput.includes('WORKER_ALIVE')) await delay(25);
    } while (!workerOutput.includes('WORKER_ALIVE') && Date.now() < outputDeadline);
    assert.match(workerOutput, /WORKER_ALIVE/);
    process.kill(workerPid, 0);
  } finally {
    await engine.close();
    if (workerPid) { try { process.kill(workerPid, 'SIGKILL'); } catch {} }
    await rm(base, { recursive: true, force: true });
  }
});

test('bounded stdout covers notification helpers and write callbacks without changing the default transport', async () => {
  const transportUrl = new URL('../dist/custom-stdio.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { setImmediate as nextTurn } from 'node:timers/promises';
    const { FilteredStdioServerTransport } = await import(${JSON.stringify(transportUrl)});
    const originalWrite = process.stdout.write;
    const writes = [];
    const capture = (chunk, encoding, callback) => {
      writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      const done = typeof encoding === 'function' ? encoding : callback;
      if (typeof done === 'function') process.nextTick(done);
      return true;
    };
    process.stdout.write = capture;
    const transport = new FilteredStdioServerTransport(1024);
    // Fewer than 1024 UTF-16 code units, but more than 1024 UTF-8 bytes.
    const huge = '🦊'.repeat(400);
    let callbacks = 0;
    try {
      transport.enableNotifications();
      writes.length = 0;
      transport.sendLog('info', huge);
      transport.sendProgress(huge, 1);
      transport.sendCustomNotification('notifications/test', { data: huge });
      console.log(huge);
      process.stdout.write(huge, () => { callbacks++; });
      process.stdout.write(Buffer.from(huge), 'utf8', () => { callbacks++; });
      process.stdout.write('{"jsonrpc":' + huge, () => { callbacks++; });
      const response = JSON.stringify({ jsonrpc: '2.0', id: 9, result: { content: [{ type: 'text', text: huge }] } }) + '\\n';
      process.stdout.write(response, () => { callbacks++; });
      process.stdout.write(Buffer.from(response), () => { callbacks++; });
      await nextTurn();
      assert.equal(callbacks, 5, 'Dropped and replaced writes must settle their callbacks.');
      assert.equal(writes.length, 2, 'Oversized notifications and non-RPC data must be dropped.');
      for (const write of writes) {
        assert.ok(Buffer.byteLength(write) <= 1024);
        const message = JSON.parse(write);
        assert.equal(message.id, 9);
        assert.deepEqual(message.result.structuredContent, { execution: 'completed', errorCode: 'result_too_large' });
      }
      writes.length = 0;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'catalog', result: { tools: huge } }));
      assert.equal(writes.length, 1);
      assert.ok(Buffer.byteLength(writes[0]) <= 1024);
      const protocolError = JSON.parse(writes[0]);
      assert.equal(protocolError.id, 'catalog');
      assert.equal(protocolError.error.code, -32603);
    } finally { transport.cleanup(); }
    assert.equal(process.stdout.write, capture, 'Cleanup must restore the real pre-wrapper writer.');
    const uncapped = new FilteredStdioServerTransport();
    try {
      uncapped.enableNotifications(); writes.length = 0;
      uncapped.sendLog('info', huge);
      assert.equal(writes.length, 1);
      assert.ok(Buffer.byteLength(writes[0]) > 1024);
    } finally { uncapped.cleanup(); process.stdout.write = originalWrite; }
    console.log('All stdout paths, callbacks, and default behavior verified.');
  `;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd: resolve(fileURLToPath(new URL('../', import.meta.url))), timeout: 10000, maxBuffer: 64 * 1024,
  });
  assert.match(result.stdout, /All stdout paths/);
});

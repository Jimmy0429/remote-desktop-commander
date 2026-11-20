import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createControlServer } from '../dist/self-host/server.js';
import { startAgent } from '../dist/self-host/agent.js';

test('CLI enrollment and real MCP file/process operations traverse server, agent, and fork engine', { timeout: 60_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jrc-e2e-')));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const ownerToken = randomBytes(32).toString('base64url');
  const ownerFile = join(root, 'owner-token'); await writeFile(ownerFile, ownerToken, { mode: 0o600 });
  const pairingFile = join(root, 'pairing'); const credentialFile = join(root, 'agent.json');
  const cli = fileURLToPath(new URL('../dist/self-host/cli.js', import.meta.url));
  const run = (...args) => promisify(execFile)(process.execPath, [cli, ...args]);
  const server = await createControlServer({ dataDir: join(root, 'server'), ownerToken, port: 0, waitMs: 1 });
  let agent; let client;
  try {
    const paired = await run('pair', '--server', server.url, '--token-file', ownerFile, '--pairing-file', pairingFile);
    const code = (await readFile(pairingFile, 'utf8')).trim();
    assert.ok(!paired.stdout.includes(code));
    const enrolled = await run('enroll', '--server', server.url, '--pairing-file', pairingFile, '--credentials', credentialFile, '--name', 'End-to-end fixture');
    const credential = JSON.parse(await readFile(credentialFile, 'utf8'));
    assert.ok(!enrolled.stdout.includes(credential.deviceToken));
    if (process.platform !== 'win32') assert.equal((await stat(credentialFile)).mode & 0o777, 0o600);
    agent = await startAgent({ serverUrl: server.url, deviceToken: credential.deviceToken, workspace, stateDir: join(root, 'engine') });
    client = new Client({ name: 'jrc-e2e', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${ownerToken}` } } }));
    for (let n = 0; n < 100; n++) {
      const devices = (await client.callTool({ name: 'list_devices', arguments: {} })).structuredContent.devices;
      if (devices.some(d => d.id === credential.deviceId && d.online)) break;
      await new Promise(r => setTimeout(r, 20));
    }
    const polledTools=new Set();
    async function call(name, args) {
      let result = await client.callTool({ name, arguments: { deviceId: credential.deviceId, ...args } });
      const id = result.structuredContent?.callId;
      if (id) {
        polledTools.add(name);
        const deadline=Date.now()+30000;
        while(result.structuredContent?.status==='running') {
          const remaining=deadline-Date.now();
          assert.ok(remaining>0,`${name} call ${id} did not complete before the polling deadline; operation was not resubmitted`);
          result = await client.callTool(
            {name:'get_remote_call',arguments:{callId:id}},
            undefined,
            {timeout:Math.min(5000,remaining)},
          );
          assert.notEqual(result.isError,true,JSON.stringify(result));
          assert.equal(result.structuredContent?.callId,id,'poll must refer to the submitted operation');
          if(result.structuredContent.status==='running') await new Promise(r=>setTimeout(r,150));
        }
        assert.equal(result.structuredContent?.status,'completed',JSON.stringify(result));
        assert.ok(result.structuredContent.result,`${name} completed without its tool result`);
        result=result.structuredContent.result;
      }
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result;
    }
    const file = join(workspace, 'round-trip.txt');
    await call('write_file', { path: file, content: 'JRC file round trip\n', mode: 'rewrite' });
    assert.equal(await readFile(file, 'utf8'), 'JRC file round trip\n');
    const read = await call('read_file', { path: file });
    assert.match(JSON.stringify(read.content), /JRC file round trip/);
    const search = await call('start_search', { path: workspace, pattern: 'JRC file round trip', searchType: 'content', literalSearch: true, timeout_ms: 1000 });
    // Upstream deliberately exposes search sessions in text, dropping internal structured facts.
    const sessionId = search.content.find(c => c.type === 'text')?.text.match(/session: (search_[A-Za-z0-9_]+)/)?.[1];
    assert.ok(sessionId, JSON.stringify(search));
    let page;
    for (let n = 0; n < 100; n++) {
      page = await call('get_more_search_results', { sessionId, offset: 0, length: 20 });
      if (page.content.some(c => c.type === 'text' && c.text.includes('Status: COMPLETED'))) break;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.match(JSON.stringify(page.content), /round-trip\.txt/);
    assert.match(JSON.stringify(page.content), /JRC file round trip/);
    const terminalFixture=join(workspace,'terminal fixture.cjs');
    // Exceed the old five-second polling window so the asynchronous call path is always exercised.
    await call('write_file',{path:terminalFixture,content:"setTimeout(()=>process.stdout.write('JRC_TERMINAL_OK'),9000)"});
    const quote=process.platform==='win32'
      ? value=>`'${value.replaceAll("'", "''")}'`
      : value=>`'${value.replaceAll("'", "'\\''")}'`;
    const command=`${process.platform==='win32'?'& ':''}${quote(process.execPath)} ${quote(terminalFixture)}`;
    const processResult = await call('start_process', { command, timeout_ms: 12000, ...(process.platform === 'win32' ? { shell: 'powershell.exe' } : {}) });
    assert.ok(polledTools.has('start_process'),'the slow terminal operation must exercise asynchronous relay result polling');
    const sessionMatch=/Process started with PID (\d+)/.exec(JSON.stringify(processResult.content));
    assert.ok(sessionMatch,JSON.stringify(processResult));
    let processOutput=JSON.stringify(processResult.content);
    const outputDeadline=Date.now()+10000;
    while(!processOutput.includes('JRC_TERMINAL_OK') && Date.now()<outputDeadline) {
      const output=await call('read_process_output',{pid:Number(sessionMatch[1]),timeout_ms:250});
      processOutput+='\n'+JSON.stringify(output.content);
    }
    assert.match(processOutput,/JRC_TERMINAL_OK/);
    const state = await readFile(join(root, 'server', 'registry.json'), 'utf8');
    assert.ok(!state.includes(ownerToken)); assert.ok(!state.includes(credential.deviceToken));
    assert.ok(!state.includes('JRC_TERMINAL_OK')); assert.ok(!state.includes('JRC file round trip'));
    const listed = await run('devices', '--server', server.url, '--token-file', ownerFile);
    assert.match(listed.stdout, /End-to-end fixture/);
    await run('revoke', '--server', server.url, '--token-file', ownerFile, '--device-id', credential.deviceId);
    const devices = (await client.callTool({ name: 'list_devices', arguments: {} })).structuredContent.devices;
    assert.equal(devices[0].online, false); assert.ok(devices[0].revokedAt);
  } finally {
    await agent?.close(); await client?.close(); await server.close(); await rm(root, { recursive: true, force: true });
  }
});

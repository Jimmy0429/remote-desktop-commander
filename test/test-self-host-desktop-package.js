import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import PizZip from 'pizzip';
import { getMcpConfigForManifest } from '@anthropic-ai/mcpb/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import builder from '../scripts/build-mcpb.cjs';
import { writePrivateFile } from '../dist/self-host/private-storage.js';
import { startAgent } from '../dist/self-host/agent.js';
import { createControlServer } from '../dist/self-host/server.js';

test('installed desktop archive reads a file from the paired device on the configured private server', { timeout: 60000 }, async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'jrc-desktop-')));
  const install = join(temp, 'Desktop Extension é');
  const client = new Client({ name: 'desktop-archive-test', version: '1' });
  let server;
  let agent;
  try {
    await mkdir(install);
    const archive = process.env.JRC_TEST_DESKTOP_ARCHIVE || await builder.buildBundle(join(temp, 'extension.mcpb'));
    const zip = new PizZip(await readFile(archive));
    const entries = Object.keys(zip.files).sort();
    assert.deepEqual(entries, ['LICENSE', 'THIRD-PARTY-NOTICES.txt', 'bridge.cjs', 'manifest.json']);
    for (const entry of entries) await writeFile(join(install, entry), zip.file(entry).asNodeBuffer());
    assert.match(zip.file('THIRD-PARTY-NOTICES.txt').asText(), /modelcontextprotocol/);
    const manifest = JSON.parse(zip.file('manifest.json').asText());
    const options = { manifest, extensionPath: install, systemDirs: {}, pathSeparator: sep };
    assert.equal(await getMcpConfigForManifest({ ...options, userConfig: {} }), undefined);

    const ownerToken = randomBytes(32).toString('base64url');
    const tokenFile = join(temp, 'client credentials', 'owner-token');
    writePrivateFile(tokenFile, ownerToken);
    server = await createControlServer({ dataDir: join(temp, 'server'), ownerToken, port: 0, waitMs: 15000 });
    const pairing = await fetch(server.url + '/api/pairings', {
      method: 'POST', headers: { Authorization: 'Bearer ' + ownerToken, 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(pairing.status, 200);
    const enrollment = await fetch(server.url + '/api/enroll', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: (await pairing.json()).code, name: 'Desktop archive fixture', platform: process.platform })
    });
    assert.equal(enrollment.status, 200);
    const { deviceId, token } = await enrollment.json();
    const workspace = join(temp, 'paired workspace');
    await mkdir(workspace);
    const file = join(workspace, 'pilot.txt');
    const marker = 'archive fixture ' + randomBytes(12).toString('hex');
    await writeFile(file, marker);
    agent = await startAgent({ serverUrl: server.url, deviceToken: token, workspace, stateDir: join(temp, 'engine') });
    const config = await getMcpConfigForManifest({
      ...options, userConfig: { server_url: server.url, credential_file: tokenFile }
    });
    assert.ok(config && !JSON.stringify(config).includes(ownerToken));
    const transport = new StdioClientTransport({ ...config, cwd: install, stderr: 'pipe' });
    transport.stderr.resume();
    await client.connect(transport, { timeout: 30000 });
    const { tools } = await client.listTools();
    assert.ok(tools.some(tool => tool.name === 'get_remote_call'));
    assert.ok(!tools.some(tool => tool.name === 'set_config_value'));
    const result = await client.callTool({ name: 'list_devices', arguments: {} });
    assert.deepEqual(result.structuredContent.devices.filter(device => device.online).map(device => device.id), [deviceId]);
    const read = await client.callTool({ name: 'read_file', arguments: { deviceId, path: file } });
    assert.notEqual(read.isError, true);
    assert.ok(JSON.stringify(read.content).includes(marker), 'The installed bridge must read the paired computer’s fixture');
  } finally {
    await client.close();
    await agent?.close();
    await server?.close();
    await rm(temp, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PDFDocument } from 'pdf-lib';
import PizZip from 'pizzip';
import { getMcpConfigForManifest } from '@anthropic-ai/mcpb/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import builder from '../scripts/build-mcpb.cjs';
import { writePrivateFile } from '../dist/self-host/private-storage.js';
import { startAgent } from '../dist/self-host/agent.js';
import { createControlServer } from '../dist/self-host/server.js';

test('installed desktop archive reads and edits files on its paired device', { timeout: 60000 }, async t => {
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
    assert.equal(client.getServerVersion()?.version, manifest.version);
    const { tools } = await client.listTools();
    assert.ok(tools.some(tool => tool.name === 'get_remote_call'));
    assert.ok(!tools.some(tool => tool.name === 'set_config_value'));
    const result = await client.callTool({ name: 'list_devices', arguments: {} });
    assert.deepEqual(result.structuredContent.devices.filter(device => device.online).map(device => device.id), [deviceId]);
    const read = await client.callTool({ name: 'read_file', arguments: { deviceId, path: file } });
    assert.notEqual(read.isError, true);
    assert.ok(JSON.stringify(read.content).includes(marker), 'The installed bridge must read the paired computer’s fixture');

    const call = (name, args) => client.callTool({ name, arguments: { deviceId, ...args } });
    await t.test('parallel edits to different lines of the same file both persist', async () => {
      const path = join(workspace, 'shared notes.txt');
      await writeFile(path, 'Label A initial\nLabel B initial\n');
      const results = await Promise.all(['A', 'B'].map(label => call('edit_block', {
        file_path: path, old_string: `Label ${label} initial`, new_string: `Label ${label} updated`
      })));
      for (const edit of results) assert.notEqual(edit.isError, true, JSON.stringify(edit.content));
      assert.equal(await readFile(path, 'utf8'), 'Label A updated\nLabel B updated\n');
    });

    await t.test('PDF page edits require a separate output and preserve the source', async () => {
      const path = join(workspace, 'original.pdf');
      const outputPath = join(workspace, 'edited.pdf');
      const pdf = await PDFDocument.create();
      pdf.addPage();
      pdf.addPage();
      const original = Buffer.from(await pdf.save());
      await writeFile(path, original);
      const content = [{ type: 'delete', pageIndexes: [1] }];

      // Only the explicit pre-execution dependency warmup can be retried.
      const deadline = Date.now() + 15000;
      let saved = await call('write_pdf', { path, outputPath, content });
      while (saved.isError && /still loading its PDF (editing|writing) support/.test(JSON.stringify(saved.content))) {
        assert.ok(Date.now() < deadline, 'PDF libraries did not finish loading');
        await delay(100);
        saved = await call('write_pdf', { path, outputPath, content });
      }
      assert.notEqual(saved.isError, true, JSON.stringify(saved.content));
      assert.equal((await PDFDocument.load(await readFile(outputPath))).getPageCount(), 1);
      const refused = await call('write_pdf', { path, content });
      assert.equal(refused.isError, true, 'Omitting outputPath must refuse the edit');
      assert.match(JSON.stringify(refused.content), /outputPath/i);
      const rangeEdit = await call('edit_block', { file_path: path, range: 'p', content });
      assert.equal(rangeEdit.isError, true, 'Private edit_block must also preserve the PDF source');
      assert.match(JSON.stringify(rangeEdit.content), /outputPath/i);
      assert.deepEqual(await readFile(path), original);
    });
  } finally {
    await client.close();
    await agent?.close();
    await server?.close();
    await rm(temp, { recursive: true, force: true });
  }
});

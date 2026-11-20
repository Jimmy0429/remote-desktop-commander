import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writePrivateFile } from '../dist/self-host/private-storage.js';
import { createControlServer } from '../dist/self-host/server.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginName = 'jimmy-remote-commander';
const jsonFile = async file => JSON.parse(await readFile(file, 'utf8'));

test('cached plugin rejects mismatched checkout and compiled versions before loading the bridge', async t => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'jrc-version-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const cache = join(temp, 'installed private plugin');
  const checkout = join(temp, 'client checkout');
  await cp(join(root, 'plugins', 'private'), cache, { recursive: true });
  const { version } = await jsonFile(join(cache, '.claude-plugin', 'plugin.json'));
  await mkdir(join(checkout, 'dist', 'self-host'), { recursive: true });
  await writeFile(join(checkout, 'dist', 'self-host', 'cli.js'),
    'process.stdout.write("unverified CLI loaded"); export function main() {}');
  const manifest = { name: '@jimmy0429/remote-desktop-commander', type: 'module', version: '0.0.0-stale' };
  await writeFile(join(checkout, 'package.json'), JSON.stringify(manifest));
  function launch() {
    return spawnSync(process.execPath, [join(cache, 'bridge.mjs')], {
      cwd: temp, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, JRC_CLIENT_ROOT: checkout, JRC_SERVER_URL: 'http://127.0.0.1:1', JRC_TOKEN_FILE: join(temp, 'missing-token') }
    });
  }
  const wrongCheckout = launch();
  assert.equal(wrongCheckout.status, 1);
  assert.equal(wrongCheckout.stdout, '');
  assert.match(wrongCheckout.stderr, /checkout version.*refresh/i);

  await writeFile(join(checkout, 'package.json'), JSON.stringify({ ...manifest, version }));
  await writeFile(join(checkout, 'dist', 'version.js'), 'export const VERSION = "0.0.0-stale";');
  const staleBuild = launch();
  assert.equal(staleBuild.status, 1);
  assert.equal(staleBuild.stdout, '');
  assert.match(staleBuild.stderr, /compiled version.*rebuild/i);
});

test('client marketplace installations connect to the private relay from outside the checkout', { timeout: 60000 }, async t => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'jrc-plugin-')));
  const clientCwd = join(temp, 'another project');
  const tokenFile = join(temp, 'private credentials', 'owner-token');
  const owner = randomBytes(32).toString('base64url');
  const { version } = await jsonFile(join(root, 'package.json'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(clientCwd);
  writePrivateFile(tokenFile, owner);
  const relay = await createControlServer({ dataDir: join(temp, 'server'), ownerToken: owner, port: 0 });
  try {
    const definitions = [];
    for (const [folder, configRoot, prefix] of [
      ['.claude-plugin', 'CLAUDE_PLUGIN_ROOT', ''],
      ['.cursor-plugin', 'CURSOR_PLUGIN_ROOT', 'env:']
    ]) {
      const marketplace = await jsonFile(join(root, folder, 'marketplace.json'));
      assert.equal(marketplace.metadata.version, version);
      const entry = marketplace.plugins.find(plugin => plugin.name === pluginName);
      assert.ok(entry, 'The private plugin must be discoverable by name');
      const installed = join(temp, 'plugin cache é', folder);
      await cp(join(root, entry.source), installed, { recursive: true });
      const manifest = await jsonFile(join(installed, folder, 'plugin.json'));
      assert.equal(manifest.version, version);
      definitions.push({ config: manifest.mcpServers[pluginName], prefix, variables: { [configRoot]: installed } });
    }
    const rootManifest = await jsonFile(join(root, 'plugin.json'));
    assert.equal(rootManifest.version, version);
    const rootMcp = await jsonFile(join(root, rootManifest.mcpServers));
    definitions.push({ config: rootMcp.mcpServers[pluginName], prefix: '', variables: {} });
    const gemini = await jsonFile(join(root, 'gemini-extension.json'));
    assert.equal(gemini.version, version);
    const installedExtension = join(temp, 'Gemini cache');
    await cp(join(root, 'plugins', 'private'), join(installedExtension, 'plugins', 'private'), { recursive: true });
    definitions.push({ config: gemini.mcpServers[pluginName], prefix: '', variables: { extensionPath: installedExtension } });

    for (const { config, prefix, variables } of definitions) {
      const values = {
        ...variables,
        [prefix + 'JRC_NODE']: process.execPath,
        [prefix + 'JRC_CLIENT_ROOT']: root,
        [prefix + 'JRC_SERVER_URL']: relay.url,
        [prefix + 'JRC_TOKEN_FILE']: tokenFile
      };
      const expand = field => field.replace(/\$\{([^}]+)\}/g, (_, key) => {
        assert.ok(Object.hasOwn(values, key), 'Unknown plugin variable: ' + key);
        return values[key];
      });
      const client = new Client({ name: 'packaged-plugin-test', version: '1' });
      const transport = new StdioClientTransport({
        command: expand(config.command), args: config.args.map(expand),
        env: Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, expand(value)])),
        cwd: clientCwd, stderr: 'pipe'
      });
      transport.stderr.resume();
      try {
        await client.connect(transport, { timeout: 30000 });
        const catalog = (await client.listTools()).tools.map(tool => tool.name);
        assert.ok(catalog.includes('get_remote_call'));
        const result = await client.callTool({ name: 'list_devices', arguments: {} });
        assert.deepEqual(result.structuredContent.devices, []);
      } finally {
        await client.close();
      }
    }
  } finally {
    await relay.close();
  }
});

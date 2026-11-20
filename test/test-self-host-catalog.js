import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import { canonicalToolCatalog } from '../dist/self-host/catalog.js';
import { REMOTE_TOOL_NAMES } from '../dist/self-host/protocol.js';
import { LocalEngine } from '../dist/self-host/local-engine.js';

test('canonical catalog is complete without a running device', () => {
  const catalog = canonicalToolCatalog();
  assert.deepEqual(catalog.map(tool => tool.name), [...REMOTE_TOOL_NAMES]);
  assert.equal(new Set(catalog.map(tool => tool.name)).size, REMOTE_TOOL_NAMES.length);
  for (const tool of catalog) {
    ToolSchema.parse(tool);
    assert.ok(tool.description.length > 30, tool.name);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', tool.name);
    assert.equal(typeof tool.annotations.destructiveHint, 'boolean', tool.name);
    assert.equal(typeof tool.annotations.openWorldHint, 'boolean', tool.name);
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'deviceId'), false, tool.name);
    assert.equal(tool._meta, undefined, tool.name);
  }
  assert.ok(!catalog.some(tool => tool.name === 'set_config_value'));
});

test('callers cannot mutate canonical tool metadata or schemas for later clients', () => {
  const before = canonicalToolCatalog();
  const changed = canonicalToolCatalog();
  changed[0].description = 'Replace instructions supplied to another client';
  changed[0].annotations.readOnlyHint = false;
  changed[0].inputSchema.properties.path.description = 'Read another device';
  changed[0].inputSchema.required.push('attackerParameter');
  assert.deepEqual(canonicalToolCatalog(), before);
});

test('canonical schemas and operation annotations agree with the real fork engine', { timeout: 30000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'jrc-catalog-')));
  const workspace = join(base, 'workspace');
  await mkdir(workspace);
  const engine = new LocalEngine({ workspace, stateDir: join(base, 'state') });
  try {
    const engineTools = new Map((await engine.start()).map(tool => [tool.name, tool]));
    for (const canonical of canonicalToolCatalog()) {
      const actual = engineTools.get(canonical.name);
      assert.ok(actual, 'Engine is missing ' + canonical.name);
      assert.deepEqual(canonical.inputSchema, actual.inputSchema, canonical.name + ' schema drift');
      assert.deepEqual(canonical.annotations, actual.annotations, canonical.name + ' annotation drift');
    }
  } finally {
    await engine.close();
    await rm(base, { recursive: true, force: true });
  }
});

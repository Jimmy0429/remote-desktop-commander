import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import lockfile from 'proper-lockfile';
import { LocalEngine } from '../dist/self-host/local-engine.js';

// Publish an atomic revision using the config writer's cross-process lock,
// then observe the engine's watcher before evaluating the policy.
async function changePolicy(engine, stateDir, allowedDirectories, revision) {
  const configFile = join(stateDir, 'config.json');
  const release = await lockfile.lock(configFile, { realpath: false, retries: { retries: 50, minTimeout: 20, maxTimeout: 100 } });
  try {
    const current = JSON.parse(await readFile(configFile, 'utf8'));
    const next = { ...current, allowedDirectories, workspaceTestRevision: revision };
    const temporary = join(stateDir, 'config-next.json');
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await rename(temporary, configFile);
  } finally {
    await release();
  }
  const deadline = Date.now() + 10000;
  let lastObserved;
  while (Date.now() < deadline) {
    const result = await engine.call('get_config', {});
    const stored = result.structuredContent?.config;
    if (stored?.workspaceTestRevision === revision) return;
    lastObserved = stored ? stored.workspaceTestRevision : JSON.stringify(result.content).slice(0, 350);
    await delay(125);
  }
  assert.fail(`Policy revision ${revision} was not observed (latest: ${lastObserved})`);
}

async function expectDenied(engine, tool, arguments_) {
  let result = await engine.call(tool, arguments_);
  // The engine starts the PDF dependency on its first request and returns
  // before calling the file handler. Wait only for that explicit startup case.
  const deadline = Date.now() + 10000;
  while (tool === 'write_pdf' && /still loading its PDF writing support/.test(JSON.stringify(result.content))) {
    assert.ok(Date.now() < deadline, 'PDF support should finish loading');
    await delay(35);
    result = await engine.call(tool, arguments_);
  }
  assert.match(JSON.stringify(result.content), /Path not allowed/i, `${tool} must report its path-policy refusal`);
}

test('private file tools intersect the launch workspace with live and persisted directory policy', { timeout: 45000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'jrc-workspace-')));
  const workspace = join(base, 'Workspace');
  const selected = join(workspace, 'Selected');
  const stateDir = join(base, 'state');
  const inside = join(selected, 'pilot.txt');
  const outside = join(base, 'outside.txt');
  let engine = new LocalEngine({ workspace, stateDir });
  try {
    await mkdir(selected, { recursive: true });
    await writeFile(inside, 'disposable pilot content');
    await writeFile(outside, 'outside fixture');
    await engine.start();
    assert.match(JSON.stringify((await engine.call('read_file', { path: inside })).content), /disposable pilot content/);
    await changePolicy(engine, stateDir, [base], 1);
    await expectDenied(engine, 'read_file', { path: outside });
    await expectDenied(engine, 'start_search', { path: base, pattern: 'pilot', searchType: 'files' });
    await expectDenied(engine, 'write_pdf', { path: join(base, 'outside.pdf'), content: 'sample' });
    await expectDenied(engine, 'move_file', { source: inside, destination: outside });
    assert.equal(await readFile(outside, 'utf8'), 'outside fixture');
    assert.match(JSON.stringify((await engine.call('read_file', { path: inside })).content), /disposable pilot content/);

    for (const [revision, dirs] of [[2, undefined], [3, []], [4, [workspace, 42]]]) {
      await changePolicy(engine, stateDir, dirs, revision);
      await expectDenied(engine, 'read_file', { path: inside });
      await expectDenied(engine, 'read_file', { path: outside });
    }
    await changePolicy(engine, stateDir, [selected], 5);
    await expectDenied(engine, 'create_directory', { path: join(workspace, 'unselected') });
    const caseVariant = join(workspace, 'selected');
    const sameDirectory = await access(caseVariant).then(() => true, () => false);
    if (!sameDirectory) {
      await mkdir(caseVariant);
      await writeFile(join(caseVariant, 'pilot.txt'), 'different directory');
      await expectDenied(engine, 'read_file', { path: join(caseVariant, 'pilot.txt') });
    } else {
      const read = await engine.call('read_file', { path: join(caseVariant, 'pilot.txt') });
      assert.match(JSON.stringify(read.content), /disposable pilot content/);
    }
    await engine.close();
    engine = new LocalEngine({ workspace, stateDir });
    await engine.start();
    assert.match(JSON.stringify((await engine.call('read_file', { path: inside })).content), /disposable pilot content/);
    await expectDenied(engine, 'create_directory', { path: join(workspace, 'unselected') });
  } finally {
    await engine.close();
    await rm(base, { recursive: true, force: true });
  }
});

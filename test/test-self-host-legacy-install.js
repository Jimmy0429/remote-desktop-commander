import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInstallScript } from './helpers/install-script.js';
import { GIT_BASH } from './helpers/powershell.js';
import { createTestEnv } from './helpers/test-env.js';

const guide = /plugins\/private\/README\.md/;

test('private setup and removal shortcuts preserve client settings and issue no commands or telemetry', async () => {
  const { bin, scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(scripts.setup, 'node setup-claude-server.js');
  assert.equal(scripts['setup:debug'], 'node setup-claude-server.js --debug');
  assert.equal(scripts.remove, 'node uninstall-claude-server.js');

  for (const script of ['setup-claude-server.js', 'uninstall-claude-server.js', bin.setup, bin.remove]) {
    const run = await runInstallScript(script, {
      privateInstaller: true,
      env: { DESKTOP_COMMANDER_DISABLE_TELEMETRY: null },
      prepare: home => writeFileSync(join(home, 'existing-settings'), 'keep'),
    });
    assert.equal(run.code, 1, run.stderr);
    assert.match(run.stderr, guide);
    assert.deepEqual(run.commands, []);
    assert.deepEqual(run.posts, []);
    assert.deepEqual(run.home, { 'existing-settings': 'keep' });
  }
});

test('checkout and piped shell installers direct private users to the guide', () => {
  const file = fileURLToPath(new URL('../install.sh', import.meta.url));
  const shell = process.platform === 'win32' ? GIT_BASH : '/bin/bash';
  const { env, home, cleanup } = createTestEnv();
  try {
    for (const args of [[file], ['-s']]) {
      const run = spawnSync(shell, args, {
        cwd: home, env, input: args[0] === '-s' ? readFileSync(file) : undefined, encoding: 'utf8', timeout: 5000,
      });
      assert.equal(run.status, 1, String(run.error || run.stderr));
      assert.match(run.stderr, guide);
    }
    assert.deepEqual(readdirSync(home), []);
  } finally {
    cleanup();
  }
});

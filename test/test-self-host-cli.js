import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

test('init creates a private owner token without disclosing or overwriting it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jrc-cli-'));
  try {
    const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('../dist/self-host/cli.js', import.meta.url)), 'init', '--data-dir', dir], { encoding: 'utf8' });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const secret = readFileSync(join(dir, 'owner-token'), 'utf8').trim();
    assert.ok(secret.length >= 43);
    assert.ok(!first.stdout.includes(secret)); assert.ok(!first.stderr.includes(secret));
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'owner-token')).mode & 0o777, 0o600);
    assert.notEqual(run().status, 0);
    assert.equal(readFileSync(join(dir, 'owner-token'), 'utf8').trim(), secret);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

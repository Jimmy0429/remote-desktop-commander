import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
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

test('Windows defaults keep credentials in LocalAppData, outside the checkout', {skip:process.platform!=='win32'}, () => {
  const root = mkdtempSync(join(tmpdir(), 'jrc-defaults-'));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/self-host/cli.js', import.meta.url)), 'init'], {
      encoding:'utf8', cwd:root, env:{...process.env, LOCALAPPDATA:root}, timeout:20000,
    });
    assert.equal(result.status,0,result.stderr);
    const tokenFile=join(root,'JimmyRemoteCommander','server','owner-token');
    const secret=readFileSync(tokenFile,'utf8').trim();
    assert.ok(secret.length>=43);
    assert.ok(!result.stdout.includes(secret));
    assert.equal(existsSync(join(root,'.self-host')),false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceRegistry } from '../dist/self-host/registry.js';

function fixture(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jrc-registry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, registry: DeviceRegistry.open(directory, options) };
}

function enroll(registry, name = 'Office PC') {
  return registry.enroll(registry.createPairing().code, name, 'win32');
}

test('pairing enrolls once, returns distinct device credentials, and never persists plaintext credentials', t => {
  const { directory, registry } = fixture(t);
  const pairing = registry.createPairing();
  const first = registry.enroll(pairing.code, 'Office PC', 'win32');
  const second = enroll(registry, 'Laptop');
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.deviceId, second.deviceId);
  assert.ok(first.token.length >= 43);
  assert.throws(() => registry.enroll(pairing.code, 'Again', 'linux'), /pairing/i);
  assert.equal(registry.authenticate(first.token).name, 'Office PC');
  assert.equal(registry.authenticate(second.token).name, 'Laptop');
  assert.equal(registry.authenticate(pairing.code), undefined);
  assert.equal(registry.authenticate('untrusted-token'), undefined);
  const disk = fs.readFileSync(path.join(directory, 'registry.json'), 'utf8');
  for (const secret of [first.token, second.token, pairing.code]) assert.ok(!disk.includes(secret));
  const publicValues = JSON.stringify([registry.list(), registry.authenticate(first.token)]);
  assert.ok(!publicValues.includes('token'));
  assert.ok(!publicValues.includes('Hash'));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(directory, 'registry.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
});

test('pairing is expired at its deadline and discarded on restart', t => {
  let now = Date.parse('2026-11-17T12:00:00Z');
  const { directory, registry } = fixture(t, { now: () => now });
  const old = registry.createPairing();
  now += 5 * 60 * 1000;
  assert.throws(() => registry.enroll(old.code, 'Late', 'linux'), /pairing/i);
  const fresh = registry.createPairing();
  const reopened = DeviceRegistry.open(directory, { now: () => now });
  assert.throws(() => reopened.enroll(fresh.code, 'Restart', 'linux'), /pairing/i);
});

test('revocation survives reload and cannot change another device or be undone through old pairing', t => {
  const { directory, registry } = fixture(t);
  const first = enroll(registry);
  const second = enroll(registry, 'Other');
  assert.equal(registry.revoke(first.deviceId), true);
  assert.equal(registry.revoke(first.deviceId), true);
  assert.equal(registry.revoke('missing'), false);
  const reopened = DeviceRegistry.open(directory);
  assert.equal(reopened.authenticate(first.token), undefined);
  assert.equal(reopened.authenticate(second.token).id, second.deviceId);
  assert.ok(reopened.list().find(device => device.id === first.deviceId).revokedAt);
  const exposed = reopened.list();
  exposed[0].name = 'Changed';
  assert.notEqual(reopened.list()[0].name, 'Changed');
  const returned = reopened.authenticate(second.token);
  returned.revokedAt = 'fake';
  assert.equal(reopened.authenticate(second.token).revokedAt, undefined);
});

test('invalid enrollment input cannot create a device or consume a valid pairing', t => {
  const { registry } = fixture(t);
  const pairing = registry.createPairing();
  for (const name of ['', ' ', 'bad\nname', 'x'.repeat(129)]) {
    assert.throws(() => registry.enroll(pairing.code, name, 'linux'), /name/i);
  }
  assert.throws(() => registry.enroll(pairing.code, 'Valid', 'unrecognized-platform'), /platform/i);
  assert.equal(registry.list().length, 0);
  assert.ok(registry.enroll(pairing.code, 'Valid', 'linux').deviceId);
});

test('corrupt or structurally invalid persisted state is refused without overwriting it', t => {
  const { directory, registry } = fixture(t);
  enroll(registry);
  const file = path.join(directory, 'registry.json');
  const valid = JSON.parse(fs.readFileSync(file, 'utf8'));
  const states = ['{broken', JSON.stringify({ version: 99 }), JSON.stringify({ ...valid, devices: [...valid.devices, valid.devices[0]] }), JSON.stringify({ ...valid, devices: [{ ...valid.devices[0], tokenHash: 'bad' }] })];
  for (const state of states) {
    fs.writeFileSync(file, state);
    assert.throws(() => DeviceRegistry.open(directory), /registry|state/i);
    assert.equal(fs.readFileSync(file, 'utf8'), state);
  }
});

test('audit keeps only bounded metadata, updates status, and reloads newest records', t => {
  const { directory, registry } = fixture(t);
  const device = enroll(registry);
  const record = { id: 'call-0', deviceId: device.deviceId, tool: 'read_file', status: 'running', startedAt: '2026-11-17T12:00:00.000Z' };
  registry.audit({ ...record, arguments: { path: 'SECRET_PATH' }, result: 'SECRET_CONTENT', token: 'SECRET_TOKEN' });
  assert.deepEqual(registry.recentAudit(), [record]);
  assert.ok(!fs.readFileSync(path.join(directory, 'registry.json'), 'utf8').includes('SECRET_'));
  registry.audit({ ...record, status: 'completed', finishedAt: '2026-11-17T12:00:01.000Z', durationMs: 1000 });
  assert.equal(registry.recentAudit().length, 1);
  assert.equal(registry.recentAudit()[0].status, 'completed');
  for (let index = 1; index <= 205; index++) registry.audit({ ...record, id: `call-${index}` });
  const reopened = DeviceRegistry.open(directory);
  const records = reopened.recentAudit();
  assert.equal(records.length, 200);
  assert.equal(records[0].id, 'call-205');
  assert.equal(records.at(-1).id, 'call-6');
  records[0].tool = 'mutated';
  assert.equal(reopened.recentAudit()[0].tool, 'read_file');
  const persisted = fs.readFileSync(path.join(directory, 'registry.json'), 'utf8');
  assert.ok(!persisted.includes('SECRET_'));
  assert.ok(!persisted.includes('arguments'));
  assert.throws(() => registry.audit({ ...record, status: 'invalid' }), /audit/i);
  assert.throws(() => registry.audit({ ...record, durationMs: Infinity }), /audit/i);
});

test('pairing and device capacity reject excess enrollment without invalidating existing credentials', t => {
  const { registry } = fixture(t);
  for (let index = 0; index < 64; index++) registry.createPairing();
  assert.throws(() => registry.createPairing(), /pairing|capacity|limit/i);
  const other = fixture(t).registry;
  const first = enroll(other);
  for (let index = 1; index < 256; index++) enroll(other, `PC ${index}`);
  assert.throws(() => enroll(other), /device|capacity|limit/i);
  assert.equal(other.authenticate(first.token).id, first.deviceId);
});

test('a failed persistent write never creates an authenticated in-memory device', t => {
  const { directory, registry } = fixture(t);
  const pairing = registry.createPairing();
  fs.mkdirSync(path.join(directory, 'registry.json'));
  assert.throws(() => registry.enroll(pairing.code, 'Blocked', 'linux'));
  assert.deepEqual(registry.list(), []);
  fs.rmdirSync(path.join(directory, 'registry.json'));
  assert.ok(registry.enroll(pairing.code, 'Retried', 'linux').deviceId);
});

test('registry refuses a symlink state file instead of reading a different private file', { skip: process.platform === 'win32' }, t => {
  const { directory } = fixture(t);
  const other = fixture(t);
  enroll(other.registry);
  const target = path.join(other.directory, 'registry.json');
  const original = fs.readFileSync(target, 'utf8');
  fs.symlinkSync(target, path.join(directory, 'registry.json'));
  assert.throws(() => DeviceRegistry.open(directory), /registry|state/i);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
});

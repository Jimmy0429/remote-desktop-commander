import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createControlServer } from '../dist/self-host/server.js';
import { DeviceRegistry } from '../dist/self-host/registry.js';

test('unauthenticated requests through a shared proxy cannot exhaust owner or valid enrollment budgets', {timeout:30000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jrc-rate-'));
  const ownerToken = randomBytes(32).toString('base64url');
  const s = await createControlServer({ dataDir, ownerToken, port: 0 });
  const headers = { Authorization: `Bearer ${ownerToken}`, 'Content-Type':'application/json' };
  try {
    const pairing = await (await fetch(s.url+'/api/pairings', {method:'POST',headers,body:'{}'})).json();
    for(let n=0;n<610;n++) await (await fetch(s.url+'/api/devices')).arrayBuffer();
    assert.equal((await fetch(s.url+'/api/devices',{headers})).status,200);
    assert.equal((await fetch(s.url)).status,200);
    for(let n=0;n<25;n++) await (await fetch(s.url+'/api/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'bad',name:'Test',platform:'linux'})})).arrayBuffer();
    assert.equal((await fetch(s.url+'/api/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:pairing.code,name:'Test',platform:'linux'})})).status,200);
  } finally { await s.close(); await rm(dataDir,{recursive:true,force:true}); }
});

test('restart recovers running audit entries even after 200 subsequent completions', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jrc-restart-'));
  const registry = DeviceRegistry.open(dataDir);
  const pairing = registry.createPairing();
  const device = registry.enroll(pairing.code,'Crashed fixture','linux');
  const startedAt = new Date().toISOString();
  for (const id of ['interrupted-write', 'interrupted-move']) {
    registry.audit({ id, deviceId: device.deviceId, tool: id === 'interrupted-move' ? 'move_file' : 'write_file', status: 'running', startedAt });
  }
  for (let i = 0; i < 200; i++) {
    registry.audit({ id: 'read-' + i, deviceId: device.deviceId, tool: 'read_file', status: 'completed', startedAt, finishedAt: startedAt });
  }
  const ownerToken = randomBytes(32).toString('base64url');
  const s = await createControlServer({dataDir,ownerToken,port:0});
  try {
    const {activity} = await (await fetch(s.url+'/api/activity',{headers:{Authorization:`Bearer ${ownerToken}`}})).json();
    assert.equal(activity.length, 200);
    for (const id of ['interrupted-write', 'interrupted-move']) {
      const recovered = activity.find(record => record.id === id);
      assert.equal(recovered?.status, 'unknown');
      assert.ok(recovered.finishedAt);
    }
    assert.equal(activity[2].id, 'read-199');
    assert.equal(activity.at(-1).id, 'read-2');
  } finally {await s.close();await rm(dataDir,{recursive:true,force:true});}
});

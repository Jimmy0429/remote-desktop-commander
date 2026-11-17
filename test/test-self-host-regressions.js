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

test('server startup reconciles interrupted persisted operations to unknown', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jrc-restart-'));
  const registry = DeviceRegistry.open(dataDir);
  const pairing = registry.createPairing();
  const device = registry.enroll(pairing.code,'Crashed fixture','linux');
  registry.audit({id:'interrupted-write',deviceId:device.deviceId,tool:'write_file',status:'running',startedAt:new Date().toISOString()});
  const ownerToken = randomBytes(32).toString('base64url');
  const s = await createControlServer({dataDir,ownerToken,port:0});
  try {
    const {activity} = await (await fetch(s.url+'/api/activity',{headers:{Authorization:`Bearer ${ownerToken}`}})).json();
    assert.equal(activity[0].status,'unknown');
    assert.ok(activity[0].finishedAt);
  } finally {await s.close();await rm(dataDir,{recursive:true,force:true});}
});

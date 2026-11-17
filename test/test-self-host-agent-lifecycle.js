import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,realpath,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import WebSocket,{WebSocketServer} from 'ws';
import {startAgent} from '../dist/self-host/agent.js';
import {createControlServer} from '../dist/self-host/server.js';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,timeout=10000) {
  const deadline=Date.now()+timeout;
  while(!predicate()) {assert.ok(Date.now()<deadline,'lifecycle condition did not become observable');await pause(25);}
}
async function bounded(promise,timeout=10000) {
  let timer;
  try {return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Lifecycle operation timed out')),timeout);})]);}
  finally {clearTimeout(timer);}
}
async function fixture() {
  const base=await realpath(await mkdtemp(join(tmpdir(),'jrc-agent-lifecycle-')));
  const workspace=join(base,'workspace'); await mkdir(workspace);
  return {base,workspace,stateDir:join(base,'state')};
}
async function unusedPort() {
  const socket=createServer(); socket.listen(0,'127.0.0.1'); await once(socket,'listening');
  const port=socket.address().port; await new Promise(resolve=>socket.close(resolve)); return port;
}
async function closeServer(server) {
  if(!server) return;
  for(const socket of server.clients) socket.terminate();
  await new Promise(resolve=>server.close(resolve));
}

test('initial network failure retries until the server becomes available', {timeout:20000}, async()=>{
  const f=await fixture(); const port=await unusedPort(); const controller=new AbortController();
  let server; let agent; let settled=false; const statuses=[];
  const started=startAgent({...f,serverUrl:`http://127.0.0.1:${port}`,deviceToken:'initial-retry-token',signal:controller.signal,
    onStatus:status=>statuses.push(status)}).then(value=>{settled=true;return {agent:value};},error=>{settled=true;return {error};});
  try {
    await waitFor(()=>settled || statuses.some(status=>status.state==='retrying'));
    assert.equal(settled,false,'a transient first connection failure must not terminate the agent');
    assert.ok(statuses.some(status=>status.state==='retrying'),'retry state should be observable');
    server=new WebSocketServer({host:'127.0.0.1',port}); await once(server,'listening');
    const result=await bounded(started); assert.ok(result.agent,result.error?.message); agent=result.agent;
    assert.ok(statuses.some(status=>status.state==='connected'));
  } finally {
    controller.abort(); const result=await started; await (agent||result.agent)?.close();
    await closeServer(server); await rm(f.base,{recursive:true,force:true});
  }
});

test('startup retry can be cancelled before the first connection', {timeout:20000},async()=>{
  const f=await fixture();const port=await unusedPort();const controller=new AbortController();
  let retrySeen=false;
  const started=startAgent({...f,serverUrl:`http://127.0.0.1:${port}`,deviceToken:'cancel-retry-token',signal:controller.signal,
    onStatus:status=>{if(status.state==='retrying')retrySeen=true;}})
    .then(agent=>({agent}),error=>({error}));
  try {
    await waitFor(()=>retrySeen);controller.abort();const result=await bounded(started);
    assert.equal(result.error?.name,'AbortError');
    await result.agent?.close();
  } finally {controller.abort();await rm(f.base,{recursive:true,force:true});}
});

test('an invalid initial credential fails explicitly without transient retries', {timeout:20000},async()=>{
  const f=await fixture();let attempts=0;
  const server=new WebSocketServer({host:'127.0.0.1',port:0,verifyClient(_info,done){attempts++;done(false,401,'Unauthorized');}});
  await once(server,'listening');
  try {
    await assert.rejects(startAgent({...f,serverUrl:`http://127.0.0.1:${server.address().port}`,deviceToken:'invalid-credential-fixture'}),/authorization.*rejected|revoked/i);
    await pause(700);assert.equal(attempts,1);
  } finally {await closeServer(server);await rm(f.base,{recursive:true,force:true});}
});

test('HTTP 403 access-policy rejection recovers without replacing the device credential', {timeout:25000},async()=>{
  const f=await fixture();const controller=new AbortController();const statuses=[];let attempts=0;let allowed=false;let settled=false;
  const server=new WebSocketServer({host:'127.0.0.1',port:0,verifyClient(_info,done){attempts++;done(allowed,allowed?undefined:403,'Access policy');}});
  await once(server,'listening');
  const started=startAgent({...f,serverUrl:`http://127.0.0.1:${server.address().port}`,deviceToken:'policy-recovery-token',signal:controller.signal,
    onStatus:status=>statuses.push(status)}).then(agent=>{settled=true;return {agent};},error=>{settled=true;return {error};});
  try {
    await waitFor(()=>settled||statuses.some(status=>status.state==='retrying'));
    assert.equal(settled,false,'HTTP 403 may be a temporary proxy or network access policy');
    const retry=statuses.find(status=>status.state==='retrying');
    assert.match(retry.message,/403.*access|access.*403/i);
    assert.ok(retry.retryDelayMs>=5000&&retry.retryDelayMs<=300000,'policy rejection must use slower, bounded retries');
    assert.equal(attempts,1);allowed=true;
    const result=await bounded(started,15000);assert.ok(result.agent,result.error?.message);
    assert.equal(attempts,2);await result.agent.close();
  } finally {controller.abort();const result=await started;await result.agent?.close();await closeServer(server);await rm(f.base,{recursive:true,force:true});}
});

test('cancellation interrupts a pending HTTP 403 retry delay', {timeout:20000},async()=>{
  const f=await fixture();const controller=new AbortController();let retry;let settled=false;
  const server=new WebSocketServer({host:'127.0.0.1',port:0,verifyClient(_info,done){done(false,403,'Access policy');}});
  await once(server,'listening');
  const started=startAgent({...f,serverUrl:`http://127.0.0.1:${server.address().port}`,deviceToken:'policy-cancel-token',signal:controller.signal,
    onStatus:status=>{if(status.state==='retrying')retry=status;}})
    .then(agent=>{settled=true;return {agent};},error=>{settled=true;return {error};});
  try {
    await waitFor(()=>retry||settled);assert.equal(settled,false);assert.ok(retry.retryDelayMs>=5000);
    controller.abort();const result=await bounded(started,2000);assert.equal(result.error?.name,'AbortError');
  } finally {controller.abort();const result=await started;await result.agent?.close();await closeServer(server);await rm(f.base,{recursive:true,force:true});}
});

test('duplicate calls report a duplicate marker while the original result still arrives', {timeout:20000},async()=>{
  const f=await fixture();const file=join(f.workspace,'duplicate-fixture.txt');await writeFile(file,'original call completed');
  const replies=[];let agent;
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  server.on('connection',socket=>socket.on('message',raw=>{
    const message=JSON.parse(raw.toString());
    if(message.type==='ready') {
      const call=JSON.stringify({type:'call',id:'duplicate-fixture',name:'read_file',arguments:{path:file}});
      socket.send(call);socket.send(call);
    } else replies.push(message);
  }));
  try {
    agent=await startAgent({...f,serverUrl:`http://127.0.0.1:${server.address().port}`,deviceToken:'duplicate-fixture-token'});
    await waitFor(()=>replies.length>=2);
    const duplicate=replies.find(message=>message.type==='error');
    assert.equal(duplicate.code,'duplicate_call');assert.equal(duplicate.execution,'unknown');
    assert.equal(replies.filter(message=>message.type==='result').length,1);
    assert.match(JSON.stringify(replies.find(message=>message.type==='result').result),/original call completed/);
  } finally {await agent?.close();await closeServer(server);await rm(f.base,{recursive:true,force:true});}
});

test('a late replacement close from an old socket cannot stop the new connection', {timeout:20000},async()=>{
  const f=await fixture();const clients=[];const peers=[];const readyPeers=new Set();let agent;let exited=false;
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  server.on('connection',socket=>{peers.push(socket);socket.on('message',raw=>{if(JSON.parse(raw.toString()).type==='ready')readyPeers.add(socket);});});
  const serverUrl=`http://127.0.0.1:${server.address().port}`;
  // Observe real outgoing sockets, then deliver a delayed event from the retired
  // generation. No real current connection or engine behavior is replaced.
  const originalEmit=WebSocket.prototype.emit;
  WebSocket.prototype.emit=function(event,...args) {
    if(event==='open'&&this.url===serverUrl.replace('http:','ws:')+'/agent')clients.push(this);
    return originalEmit.call(this,event,...args);
  };
  try {
    agent=await startAgent({...f,serverUrl,deviceToken:'stale-close-token'});agent.closed.then(()=>{exited=true;});
    await waitFor(()=>peers.length===1);peers[0].close(1001,'Transient fixture restart');
    await waitFor(()=>clients.length===2&&peers.length===2&&readyPeers.has(peers[1]));
    clients[0].emit('close',4009,Buffer.from('Late replacement'));
    const reply=once(peers[1],'message');
    peers[1].send(JSON.stringify({type:'call',id:'after-stale-close',name:'list_directory',arguments:{path:f.workspace}}));
    const [raw]=await bounded(reply);const result=JSON.parse(raw.toString());
    assert.equal(result.type,'result');assert.equal(result.id,'after-stale-close');assert.equal(exited,false);
  } finally {WebSocket.prototype.emit=originalEmit;await agent?.close();await closeServer(server);await rm(f.base,{recursive:true,force:true});}
});

test('real server replacement stops the older agent without reconnect ping-pong', {timeout:25000},async()=>{
  const f=await fixture();const ownerToken='owner-collision-fixture-'.repeat(3);const agents=[];let service;let secondExited=false;
  try {
    service=await createControlServer({dataDir:join(f.base,'server'),ownerToken,port:0});
    const post=async(path,body,owner=false)=>{
      const response=await fetch(service.url+path,{method:'POST',headers:{'Content-Type':'application/json',...(owner?{Authorization:`Bearer ${ownerToken}`}:{})},
        body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
      assert.equal(response.status,200);return response.json();
    };
    const pairing=await post('/api/pairings',{},true);
    const enrolled=await post('/api/enroll',{code:pairing.code,name:'Collision fixture',platform:process.platform});
    const options={workspace:f.workspace,serverUrl:service.url,deviceToken:enrolled.token};
    const first=await startAgent({...options,stateDir:join(f.base,'first')});agents.push(first);
    const second=await startAgent({...options,stateDir:join(f.base,'second')});agents.push(second);second.closed.then(()=>{secondExited=true;});
    const replaced=await bounded(first.closed);assert.equal(replaced.reason,'replaced');assert.equal(replaced.exitCode,1);
    await pause(1200);assert.equal(secondExited,false,'the older agent must not reconnect and evict its replacement');
    const response=await fetch(service.url+'/api/devices',{headers:{Authorization:`Bearer ${ownerToken}`},signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200);const {devices}=await response.json();
    assert.equal(devices.find(device=>device.id===enrolled.deviceId)?.online,true);
  } finally {await Promise.all(agents.map(agent=>agent.close()));await service?.close();await rm(f.base,{recursive:true,force:true});}
});

for(const [code,reason,diagnostic] of [[4009,'replaced',/replaced|another agent/i],[4003,'authorization',/revoked|authorization/i]]) {
  test(`terminal close ${code} reports ${reason} and never reconnects`, {timeout:20000},async()=>{
    const f=await fixture();let agent;let connections=0;
    const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
    server.on('connection',socket=>{connections++;socket.once('message',()=>socket.close(code,'fixture'));});
    try {
      agent=await startAgent({...f,serverUrl:`http://127.0.0.1:${server.address().port}`,deviceToken:'fatal-test-token'});
      assert.ok(agent.closed instanceof Promise,'caller needs an observable terminal status');
      const result=await bounded(agent.closed);
      assert.equal(result.reason,reason);assert.equal(result.exitCode,1);assert.match(result.message,diagnostic);
      await pause(700);assert.equal(connections,1);
    } finally {await agent?.close();await closeServer(server);await rm(f.base,{recursive:true,force:true});}
  });
}

test('CLI reports credential revocation and exits unsuccessfully', {timeout:25000},async()=>{
  const f=await fixture();let child;
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  server.on('connection',socket=>socket.once('message',()=>socket.close(4003,'fixture')));
  const credential=join(f.base,'credential.json');
  await writeFile(credential,JSON.stringify({serverUrl:`http://127.0.0.1:${server.address().port}`,deviceToken:'cli-lifecycle-secret'}),{mode:0o600});
  try {
    child=spawn(process.execPath,[fileURLToPath(new URL('../dist/self-host/cli.js',import.meta.url)),'agent','--credentials',credential,
      '--workspace',f.workspace,'--state-dir',f.stateDir],{stdio:['ignore','pipe','pipe']});
    let stdout='';let stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    const [code]=await bounded(once(child,'exit'),15000);
    assert.equal(code,1);assert.match(stderr,/revoked|authorization/i);
    assert.ok(!(stdout+stderr).includes('cli-lifecycle-secret'));
  } finally {child?.kill();await closeServer(server);await rm(f.base,{recursive:true,force:true});}
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(),'jrc-agent-')));
  const workspace = path.join(base,'workspace');
  await mkdir(workspace);
  return {base,workspace,stateDir:path.join(base,'state')};
}

test('wire validation rejects malformed, oversized and non-allowlisted operations', async () => {
  const {parseAgentMessage,parseServerMessage,MAX_MESSAGE_BYTES,safeRemoteUrl} = await import('../dist/self-host/protocol.js');
  assert.equal(parseServerMessage({type:'call',id:'abc',name:'read_file',arguments:{path:'/tmp/file'}}).name,'read_file');
  assert.throws(()=>parseServerMessage({type:'call',id:'abc',name:'set_config_value',arguments:{}}));
  assert.throws(()=>parseAgentMessage({type:'result',id:'abc',result:{content:'wrong'}}));
  assert.throws(()=>parseAgentMessage(' '.repeat(MAX_MESSAGE_BYTES+1)));
  assert.throws(()=>safeRemoteUrl('http://example.com'));
  assert.throws(()=>safeRemoteUrl('https://user:secret@example.com'));
  assert.throws(()=>safeRemoteUrl('https://example.com/?token=secret'));
  assert.equal(safeRemoteUrl('https://example.com').origin,'https://example.com');
  assert.equal(safeRemoteUrl('http://127.0.0.1:1234').port,'1234');
});

test('local engine serves real isolated file tools and refuses policy-changing tools', {timeout:30000}, async () => {
  const {LocalEngine} = await import('../dist/self-host/local-engine.js');
  const f = await fixture();
  const engine = new LocalEngine(f);
  try {
    const tools = await engine.start();
    assert.ok(tools.some(t=>t.name==='read_file'));
    assert.ok(!tools.some(t=>t.name==='set_config_value'));
    const target = path.join(f.workspace,'hello.txt');
    const result = await engine.call('write_file',{path:target,content:'round-trip'});
    assert.ok(!result.isError);
    assert.equal(await readFile(target,'utf8'),'round-trip');
    const read = await engine.call('read_file',{path:target});
    assert.match(JSON.stringify(read),/round-trip/);
    const outside = await engine.call('read_file',{path:path.join(f.base,'outside.txt')});
    assert.ok(outside.isError || JSON.stringify(outside).includes('denied'));
    await assert.rejects(engine.call('set_config_value',{key:'allowedDirectories',value:[]}),/not allowed/i);
  } finally { await engine.close(); await rm(f.base,{recursive:true,force:true}); }
  await assert.rejects(engine.call('read_file',{path:'/tmp/test'}),/not running|closed/i);
});

test('closing the local engine reaps terminal child processes', {timeout:30000}, async () => {
  const {LocalEngine} = await import('../dist/self-host/local-engine.js');
  const f=await fixture();
  const engine=new LocalEngine(f);
  let worker;
  try {
    await engine.start();
    const quote=process.platform==='win32'
      ? value=>`'${value.replaceAll("'", "''")}'`
      : value=>`'${value.replaceAll("'", "'\\''")}'`;
    // Delayed output makes the readiness race deterministic even on a fast local machine.
    const code="setTimeout(()=>console.log('WORKER-PID:'+process.pid),600);setTimeout(()=>{},60000)";
    const workerFile=path.join(f.workspace,'terminal worker.cjs');
    await writeFile(workerFile,code);
    // PowerShell's call operator executes a quoted path; the fixture path also exercises spaces.
    const command=`${process.platform==='win32'?'& ':''}${quote(process.execPath)} ${quote(workerFile)}`;
    const result=await engine.call('start_process',{command,timeout_ms:300,...(process.platform === 'win32' ? {shell:'powershell.exe'} : {})});
    assert.ok(!result.isError,JSON.stringify(result));
    const sessionMatch=/Process started with PID (\d+)/.exec(JSON.stringify(result));
    assert.ok(sessionMatch,JSON.stringify(result));
    const sessionPid=Number(sessionMatch[1]);
    let observed=JSON.stringify(result);
    let match=/WORKER-PID:(\d+)/.exec(observed);
    const readyDeadline=Date.now()+10000;
    while(!match && Date.now()<readyDeadline) {
      const output=await engine.call('read_process_output',{pid:sessionPid,timeout_ms:250});
      assert.ok(!output.isError,JSON.stringify(output));
      observed+='\n'+JSON.stringify(output);
      match=/WORKER-PID:(\d+)/.exec(observed);
    }
    assert.ok(match,`Worker did not report its PID before the readiness deadline: ${observed}`);
    worker=Number(match[1]);
    process.kill(worker,0);
    await engine.close();
    const deadline=Date.now()+5000;
    while(Date.now()<deadline) {
      try { process.kill(worker,0); } catch { worker=undefined; break; }
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(worker,undefined,'terminal worker should exit with its engine');
  } finally {
    if(worker) { try { process.kill(worker,'SIGKILL'); } catch {} }
    await engine.close();
    await rm(f.base,{recursive:true,force:true});
  }
});

test('document support loads on demand without startup preloading', {timeout:30000}, async () => {
  const {LocalEngine}=await import('../dist/self-host/local-engine.js');
  const {PDFDocument,StandardFonts}=await import('pdf-lib');
  const f=await fixture();
  const engine=new LocalEngine(f);
  const readyCall=async(name,args)=>{
    const deadline=Date.now()+10000;
    while(true) {
      const result=await engine.call(name,args);
      if(!result.isError) return result;
      // This explicit upstream error occurs before file mutation; arbitrary failures are never retried.
      assert.match(JSON.stringify(result),/still loading/);
      assert.ok(Date.now()<deadline,'document package should eventually load');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  };
  try {
    await engine.start();
    const xlsx=path.join(f.workspace,'sample.xlsx');
    const first=await engine.call('write_file',{path:xlsx,content:'[["Name","Count"],["Example",3]]'});
    assert.equal(first.isError,true);
    assert.match(JSON.stringify(first),/still loading/);
    await readyCall('write_file',{path:xlsx,content:'[["Name","Count"],["Example",3]]'});
    assert.match(JSON.stringify(await readyCall('read_file',{path:xlsx})),/Example/);
    const docx=path.join(f.workspace,'sample.docx');
    await readyCall('write_file',{path:docx,content:'# Lazy document\nFixture paragraph'});
    assert.match(JSON.stringify(await readyCall('read_file',{path:docx})),/Fixture paragraph/);
    const pdf=await PDFDocument.create();
    const font=await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText('Lazy PDF fixture',{x:50,y:700,font,size:14});
    const pdfPath=path.join(f.workspace,'sample.pdf');
    await writeFile(pdfPath,await pdf.save());
    assert.match(JSON.stringify(await readyCall('read_file',{path:pdfPath})),/Lazy PDF fixture/);
  } finally { await engine.close(); await rm(f.base,{recursive:true,force:true}); }
});

test('agent authenticates, routes exactly once and reconnects without replay', {timeout:45000}, async () => {
  const {startAgent} = await import('../dist/self-host/agent.js');
  const f = await fixture();
  const wss = new WebSocketServer({host:'127.0.0.1',port:0});
  await once(wss,'listening');
  const connections=[];
  const ready=[];
  const responses=[];
  wss.on('connection',(ws,req)=>{
    assert.equal(req.url,'/agent');
    assert.equal(req.headers.authorization,'Bearer agent-test-token');
    connections.push(ws);
    ws.on('message',raw=>{
      const message=JSON.parse(raw.toString());
      if(message.type==='ready') ready.push(ws); else responses.push(message);
    });
  });
  const waitFor=async predicate=>{
    const deadline=Date.now()+12000;
    while(!predicate()) { if(Date.now()>deadline) throw new Error('Condition not reached'); await new Promise(r=>setTimeout(r,25)); }
  };
  let agent;
  try {
    agent=await startAgent({...f,deviceToken:'agent-test-token',serverUrl:`http://127.0.0.1:${wss.address().port}`});
    await waitFor(()=>ready.length===1);
    const target=path.join(f.workspace,'once.txt');
    const call={type:'call',id:'same-call',name:'write_file',arguments:{path:target,content:'one',mode:'append'}};
    connections[0].send(JSON.stringify(call));
    await waitFor(()=>responses.some(r=>r.id==='same-call'&&r.type==='result'));
    connections[0].send(JSON.stringify(call));
    await waitFor(()=>responses.some(r=>r.id==='same-call'&&r.type==='error'));
    assert.equal(await readFile(target,'utf8'),'one');
    connections[0].terminate();
    await waitFor(()=>ready.length===2);
    connections[1].send(JSON.stringify(call));
    await waitFor(()=>responses.filter(r=>r.id==='same-call'&&r.type==='error').length===2);
    assert.equal(await readFile(target,'utf8'),'one');
  } finally {
    await agent?.close();
    for(const ws of connections) ws.terminate();
    await new Promise(resolve=>wss.close(resolve));
    await rm(f.base,{recursive:true,force:true});
  }
});

test('agent stops reconnecting after the server rejects a revoked credential', {timeout:20000}, async () => {
  const {startAgent}=await import('../dist/self-host/agent.js');
  const f=await fixture();
  let attempts=0;
  const wss=new WebSocketServer({host:'127.0.0.1',port:0,verifyClient(_info,done){attempts++;done(attempts===1,401,'Unauthorized');}});
  await once(wss,'listening');
  const connected=once(wss,'connection');
  let agent;
  try {
    agent=await startAgent({...f,deviceToken:'revoked-test-token',serverUrl:`http://127.0.0.1:${wss.address().port}`});
    const [socket]=await connected;
    socket.terminate();
    await new Promise(resolve=>setTimeout(resolve,1600));
    assert.equal(attempts,2,'authorization failure should stop retries rather than repeatedly send a revoked credential');
  } finally {
    await agent?.close();
    for(const socket of wss.clients) socket.terminate();
    await new Promise(resolve=>wss.close(resolve));
    await rm(f.base,{recursive:true,force:true});
  }
});

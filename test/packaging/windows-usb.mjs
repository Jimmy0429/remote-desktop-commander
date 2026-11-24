// Native acceptance of the extracted deliverable, without a system Node on PATH.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import PizZip from 'pizzip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createControlServer } from '../../dist/self-host/server.js';

assert.equal(process.platform, 'win32');
const zipPath = resolve(process.argv[2]);
const bytes = await readFile(zipPath);
const zip = new PizZip(bytes);
const top = 'JimmyRemoteCommander-USB/';
const files = Object.keys(zip.files).filter(name => !zip.files[name].dir);
const expected = ['app/portable.cjs', 'runtime/node.exe', 'runtime/LICENSE', 'LICENSE', 'THIRD-PARTY-NOTICES.txt',
  'README.txt', 'CHECK-USB.cmd', 'START-PILOT.cmd', 'portable-launcher.mjs', 'BUILD.json'];
assert.deepEqual(files.sort(), expected.map(f => top + f).sort());
const meta = JSON.parse(zip.file(top + 'BUILD.json').asText());
assert.equal(meta.architecture, process.arch);
assert.equal(meta.sourceCommit, execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim());
const hash = data => createHash('sha256').update(data).digest('hex');
for (const name of expected.filter(name => name !== 'BUILD.json')) {
  assert.equal(hash(zip.file(top + name).asNodeBuffer()), meta.files[name], name);
}

const root = await realpath(await mkdtemp(join(tmpdir(), 'jrc-usb-package-')));
const profile = join(root, 'Test profile');
const extract = join(root, 'USB drive & spaces');
const pkg = join(extract, top);
const win = process.env.SystemRoot;
const comspec = join(win, 'System32', 'cmd.exe');
const sandboxEnv = {
  SystemRoot:win, windir:win, ComSpec:comspec, TEMP:tmpdir(), TMP:tmpdir(), LOCALAPPDATA:profile,
  PATH:[join(win, 'System32'), win, join(win, 'System32', 'WindowsPowerShell', 'v1.0')].join(';'),
  PATHEXT:'.COM;.EXE;.BAT;.CMD',
};
const children = new Set();
function launch(file, answers) {
  const proc = spawn(comspec, ['/d', '/c', file], {cwd:pkg, env:sandboxEnv, stdio:'pipe'});
  children.add(proc);
  let output = '';
  proc.stdout.on('data', d => { output += d.toString(); });
  proc.stderr.on('data', d => { output += d.toString(); });
  const done = new Promise((yes, no) => {
    proc.once('error', no);
    proc.once('close', code => { children.delete(proc); yes(code); });
  });
  proc.stdin.end(answers.join('\r\n')+'\r\n');
  return {proc, done, output:()=>output};
}
async function finished(child, timeoutMs=75000) {
  const timer = new AbortController();
  try {
    return await Promise.race([child.done, delay(timeoutMs, undefined, {signal:timer.signal}).then(() => {
      throw new Error('Packaged launcher timed out');
    })]);
  } finally { timer.abort(); }
}
const client = new Client({name:'Windows USB acceptance',version:'1'});
let relay;
try {
  await mkdir(profile); await mkdir(extract);
  execFileSync(join(win,'System32','tar.exe'), ['-xf',zipPath,'-C',extract]);
  const runtime = join(pkg,'runtime','node.exe');
  assert.equal(execFileSync(runtime,['-p','process.version+" "+process.arch'],{cwd:pkg,env:sandboxEnv,encoding:'utf8'}).trim(),'v22.23.5 '+process.arch);
  const cancel = launch('CHECK-USB.cmd', ['']);
  assert.equal(await finished(cancel),0); assert.match(cancel.output(),/Cancelled/);
  assert.deepEqual(await readdir(profile), []);
  const check = launch('CHECK-USB.cmd', ['CHECK']);
  assert.equal(await finished(check),0,check.output()); assert.match(check.output(),/PASS:/);
  assert.deepEqual(await readdir(profile), []);
  console.log('PASS: extracted offline CMD launcher uses bundled Node and cleans its scratch directory');

  const owner = randomBytes(32).toString('base64url');
  relay = await createControlServer({dataDir:join(root,'owner'),host:'127.0.0.1',port:0,ownerToken:owner});
  const post = async (path,body) => {
    const response = await fetch(relay.url+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+owner},body:JSON.stringify(body)});
    assert.equal(response.status,200); return response.json();
  };
  const {code} = await post('/api/pairings',{});
  const first = launch('START-PILOT.cmd',[relay.url,'PAIR',code]);
  await client.connect(new StreamableHTTPClientTransport(new URL(relay.url+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+owner}}}));
  async function ready(session) {
    const deadline=Date.now()+60000;
    while(Date.now()<deadline) {
      assert.equal(session.proc.exitCode,null,'Launcher exited before connecting');
      const res=await client.callTool({name:'list_devices',arguments:{}});
      const device=res.structuredContent.devices.find(d=>d.online);
      const path=session.output().match(/Pilot file: ([^\r\n]+)/)?.[1];
      if(device && path && session.output().includes('Device connected'))return {deviceId:device.id,path};
      await delay(125);
    }
    throw new Error('Packaged device did not become ready');
  }
  const current=await ready(first);
  assert.ok(!relative(profile,current.path).startsWith('..')); assert.equal(basename(current.path),'pilot-check.txt');
  assert.ok(first.output().includes(current.deviceId));assert.ok(!first.output().includes(code));
  const call=(name,args)=>client.callTool({name,arguments:{deviceId:current.deviceId,...args}});
  const marker='portable '+randomBytes(10).toString('hex');
  assert.ok(!(await call('write_file',{path:current.path,content:marker})).isError);
  assert.equal(await readFile(current.path,'utf8'),marker);
  assert.ok(JSON.stringify((await call('read_file',{path:current.path})).content).includes(marker));
  assert.equal((await call('list_directory',{path:dirname(current.path)})).isError,true);
  const different=await call('write_file',{path:join(dirname(current.path),'other.txt'),content:'refused'});
  assert.equal(different.isError,true); assert.deepEqual(await readdir(dirname(current.path)),['pilot-check.txt']);
  const declined=launch('START-PILOT.cmd',['']);
  assert.equal(await finished(declined),0); assert.match(declined.output(),/Cancelled/);
  const next=launch('START-PILOT.cmd',['START']); const later=await ready(next);
  assert.equal(await finished(first),1);assert.equal(later.deviceId,current.deviceId);
  assert.notEqual(later.path,current.path);assert.equal(await readFile(later.path,'utf8'),'');
  assert.equal((await call('read_file',{path:current.path})).isError,true);
  await post('/api/devices/'+current.deviceId+'/revoke',{});
  assert.equal(await finished(next),1);
  for(const name of expected)assert.equal(hash(await readFile(join(pkg,name))),hash(zip.file(top+name).asNodeBuffer()));
  assert.deepEqual((await readdir(pkg)).sort(),[...new Set(expected.map(s=>s.split('/')[0]))].sort());
  console.log('PASS: paired CMD requires consent, preserves credentials off USB, scopes remote calls, resumes with a fresh file and stops on revocation');
  console.log('NATIVE-USB SHA256='+hash(bytes)+' bytes='+bytes.length+' arch='+process.arch+' commit='+meta.sourceCommit);
} finally {
  for(const proc of children) {
    if(proc.pid && proc.exitCode===null) {
      try { execFileSync(join(win,'System32','taskkill.exe'),['/pid',String(proc.pid),'/t','/f'],{stdio:'ignore'}); } catch {}
    }
  }
  try {await client.close();} finally {
    try {await relay?.close();} finally {await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:300});}
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,chmodSync,statSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {fileURLToPath} from 'node:url';

const cli=fileURLToPath(new URL('../dist/self-host/cli.js',import.meta.url));
const run=(...args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:20000});
const psScript=String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$r=ConvertFrom-Json ([Console]::In.ReadToEnd())
$acl=Get-Acl -LiteralPath $r.path
if($r.action -eq 'broad' -or $r.action -eq 'replaceable') {
  $sid=[Security.Principal.SecurityIdentifier]::new([string]$r.sid)
  $rights=if($r.action -eq 'replaceable') {'Modify,DeleteSubdirectoriesAndFiles'} else {'ReadAndExecute'}
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,$rights,'ContainerInherit,ObjectInherit','None','Allow')
  if(-not (Get-Item -LiteralPath $r.path).PSIsContainer) {$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'Read','Allow')}
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $r.path -AclObject $acl
  $acl=Get-Acl -LiteralPath $r.path
}
$rules=@($acl.Access | ForEach-Object { [pscustomobject]@{sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;allow=($_.AccessControlType -eq 'Allow');inherited=$_.IsInherited} })
[pscustomobject]@{owner=$acl.Owner;protected=$acl.AreAccessRulesProtected;rules=$rules} | ConvertTo-Json -Depth 5 -Compress
`;
function windowsAcl(path,action='inspect',sid='S-1-5-32-545') {
  const result=spawnSync(join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
    ['-NoProfile','-NonInteractive','-Command',psScript],{input:JSON.stringify({path,action,sid}),encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout.replace(/^\uFEFF/,''));
}
function makeBroad(path) {if(process.platform==='win32')windowsAcl(path,'broad');else chmodSync(path,statSync(path).isDirectory()?0o755:0o644);}
function privacySnapshot(path) {return process.platform==='win32'?windowsAcl(path):statSync(path).mode&0o777;}

test('new secret storage is protected without changing its existing parent',()=>{
  const root=mkdtempSync(join(tmpdir(),'jrc-private-new-'));
  try {
    makeBroad(root);const before=privacySnapshot(root);const state=join(root,'private-state');
    const result=run('init','--data-dir',state);assert.equal(result.status,0,result.stderr);
    assert.deepEqual(privacySnapshot(root),before);
    assert.ok(readFileSync(join(state,'owner-token'),'utf8').trim().length>=43);
    if(process.platform==='win32') {
      assert.equal(windowsAcl(state).protected,true);
      assert.ok(!windowsAcl(join(state,'owner-token')).rules.some(rule=>rule.allow&&rule.sid==='S-1-5-32-545'));
    } else {assert.equal(privacySnapshot(state),0o700);assert.equal(privacySnapshot(join(state,'owner-token')),0o600);}
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('existing insecure storage is refused before writing a secret',()=>{
  const root=mkdtempSync(join(tmpdir(),'jrc-private-refusal-'));
  try {
    makeBroad(root);const before=privacySnapshot(root);
    const result=run('init','--data-dir',root);
    assert.notEqual(result.status,0,'insecure existing directory must not receive a secret');
    assert.match(result.stderr,/private|permission|protect|ACL/i);
    assert.equal(existsSync(join(root,'owner-token')),false);assert.deepEqual(privacySnapshot(root),before);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('explicit protection repairs dedicated state and refuses unrelated directories',()=>{
  const root=mkdtempSync(join(tmpdir(),'jrc-private-protect-'));
  try {
    const state=join(root,'state');mkdirSync(state);writeFileSync(join(state,'agent.json'),JSON.stringify({serverUrl:'http://127.0.0.1:1',deviceToken:'fixture'}));
    makeBroad(state);makeBroad(join(state,'agent.json'));
    const protectedResult=run('protect','--data-dir',state);assert.equal(protectedResult.status,0,protectedResult.stderr);
    const read=run('agent','--credentials',join(state,'agent.json'));
    assert.match(read.stderr,/Choose --workspace/,'validated private credentials should reach ordinary argument validation');
    const unrelated=join(root,'workspace');mkdirSync(unrelated);writeFileSync(join(unrelated,'customer-data.txt'),'unchanged');
    const before=privacySnapshot(unrelated);assert.notEqual(run('protect','--data-dir',unrelated).status,0);
    assert.deepEqual(privacySnapshot(unrelated),before);assert.equal(readFileSync(join(unrelated,'customer-data.txt'),'utf8'),'unchanged');
    for(const unsafe of [process.cwd(),homedir()]) assert.notEqual(run('protect','--data-dir',unsafe).status,0);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('Windows credential reads reject explicit broad read grants', {skip:process.platform!=='win32'},()=>{
  const root=mkdtempSync(join(tmpdir(),'jrc-private-read-'));
  try {
    const state=join(root,'state');assert.equal(run('init','--data-dir',state).status,0);
    const credential=join(state,'agent.json');writeFileSync(credential,JSON.stringify({serverUrl:'http://127.0.0.1:1',deviceToken:'fixture'}));
    for(const sid of ['S-1-5-32-545','S-1-1-0','S-1-5-11']) {
      windowsAcl(credential,'broad',sid);const result=run('agent','--credentials',credential);
      assert.notEqual(result.status,0);assert.match(result.stderr,/private|permission|protect|ACL/i);assert.doesNotMatch(result.stderr,/Choose --workspace/);
      assert.equal(run('protect','--data-dir',state).status,0);
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('Windows credential reads recheck inherited access and parent replacement rights', {skip:process.platform!=='win32'},()=>{
  const root=mkdtempSync(join(tmpdir(),'jrc-private-parent-'));
  try {
    const state=join(root,'state');assert.equal(run('init','--data-dir',state).status,0);
    const credential=join(state,'agent.json');writeFileSync(credential,JSON.stringify({serverUrl:'http://127.0.0.1:1',deviceToken:'fixture'}));
    assert.match(run('agent','--credentials',credential).stderr,/Choose --workspace/);
    windowsAcl(state,'broad','S-1-5-11');
    assert.ok(windowsAcl(credential).rules.some(rule=>rule.sid==='S-1-5-11'&&rule.inherited));
    assert.doesNotMatch(run('agent','--credentials',credential).stderr,/Choose --workspace/);
    assert.equal(run('protect','--data-dir',state).status,0);
    windowsAcl(root,'replaceable');
    const after=run('agent','--credentials',credential);assert.notEqual(after.status,0);assert.match(after.stderr,/private|permission|protect|ACL/i);
    assert.notEqual(run('init','--data-dir',join(root,'another-state')).status,0);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('private storage refuses directory links and protects no linked target',()=>{
  const root=mkdtempSync(join(tmpdir(),'jrc-private-link-'));
  try {
    const target=join(root,'target');mkdirSync(target,{mode:0o700});const link=join(root,'linked');
    symlinkSync(target,link,process.platform==='win32'?'junction':'dir');
    assert.notEqual(run('init','--data-dir',link).status,0);assert.equal(existsSync(join(target,'owner-token')),false);
    const state=join(root,'state');mkdirSync(state,{mode:0o700});symlinkSync(target,join(state,'engine'),process.platform==='win32'?'junction':'dir');
    const before=privacySnapshot(target);assert.notEqual(run('protect','--data-dir',state).status,0);assert.deepEqual(privacySnapshot(target),before);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('Windows registry replacement files retain private DACLs', {skip:process.platform!=='win32'},async()=>{
  const root=mkdtempSync(join(tmpdir(),'jrc-private-registry-'));
  try {
    const {DeviceRegistry}=await import('../dist/self-host/registry.js');
    const state=join(root,'state');const registry=DeviceRegistry.open(state);
    const first=registry.enroll(registry.createPairing().code,'ACL fixture','win32');
    registry.revoke(first.deviceId);
    assert.equal(windowsAcl(state).protected,true);
    assert.ok(!windowsAcl(join(state,'registry.json')).rules.some(rule=>rule.allow&&['S-1-1-0','S-1-5-11','S-1-5-32-545'].includes(rule.sid)));
    assert.ok(DeviceRegistry.open(state).list()[0].revokedAt);
  } finally {rmSync(root,{recursive:true,force:true});}
});

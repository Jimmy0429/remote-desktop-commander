import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,chmodSync,statSync,rmSync,symlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
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
if($r.action -eq 'null') {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JrcNullAclFixture {
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)]
  public static extern uint SetNamedSecurityInfo(string name,uint type,uint info,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)]
  public static extern uint GetNamedSecurityInfo(string name,uint type,uint info,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr handle);
  public static bool SetNull(string path) {
    uint code=SetNamedSecurityInfo(path,1,0x80000004,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
    if(code!=0) throw new System.ComponentModel.Win32Exception((int)code);
    IntPtr owner,group,dacl,sacl,descriptor;
    code=GetNamedSecurityInfo(path,1,4,out owner,out group,out dacl,out sacl,out descriptor);
    if(code!=0) throw new System.ComponentModel.Win32Exception((int)code);
    bool result=dacl==IntPtr.Zero;LocalFree(descriptor);return result;
  }
}
'@
  $nullDacl=[JrcNullAclFixture]::SetNull([string]$r.path)
  $acl=Get-Acl -LiteralPath $r.path
}
$rules=@($acl.Access | ForEach-Object { [pscustomobject]@{sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;allow=($_.AccessControlType -eq 'Allow');inherited=$_.IsInherited} })
[pscustomobject]@{owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;protected=$acl.AreAccessRulesProtected;nullDacl=$nullDacl;rules=$rules} | ConvertTo-Json -Depth 5 -Compress
`;
function windowsAcl(path,action='inspect',sid='S-1-5-32-545') {
  const executable=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>name.toLowerCase()!=='psmodulepath'));
  env.PSModulePath=join(dirname(executable),'Modules');
  const result=spawnSync(executable,
    ['-NoProfile','-NonInteractive','-Command',psScript],{input:JSON.stringify({path,action,sid}),env,encoding:'utf8',timeout:15000,windowsHide:true});
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

test('Windows storage helper ignores inherited untrusted PowerShell module paths', {skip:process.platform!=='win32'},()=>{
  const root=mkdtempSync(join(tmpdir(),'jrc-private-modules-'));
  try {
    const modules=join(root,'modules');const module=join(modules,'Microsoft.PowerShell.Security');mkdirSync(module,{recursive:true});
    const marker=join(root,'untrusted-module-loaded');
    writeFileSync(join(module,'Microsoft.PowerShell.Security.psd1'),"@{RootModule='Microsoft.PowerShell.Security.psm1';ModuleVersion='99.0.0';FunctionsToExport=@('Get-Acl','Set-Acl')}");
    writeFileSync(join(module,'Microsoft.PowerShell.Security.psm1'),"[IO.File]::WriteAllText($env.JRC_UNTRUSTED_MODULE_MARKER,'unexpected'); throw 'UNTRUSTED_MODULE_LOADED'");
    const state=join(root,'state');
    const inherited=Object.fromEntries(Object.entries(process.env).filter(([name])=>name.toLowerCase()!=='psmodulepath'));
    const result=spawnSync(process.execPath,[cli,'init','--data-dir',state],{encoding:'utf8',timeout:20000,
      env:{...inherited,PSModulePath:modules,JRC_UNTRUSTED_MODULE_MARKER:marker}});
    assert.equal(result.status,0,result.stderr);assert.equal(existsSync(marker),false);
    assert.equal(windowsAcl(state).protected,true);assert.ok(existsSync(join(state,'owner-token')));
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('Windows storage refuses a real null DACL and a foreign owner', {skip:process.platform!=='win32'},async()=>{
  const {assertPrivateFile}=await import('../dist/self-host/private-storage.js');
  const root=mkdtempSync(join(tmpdir(),'jrc-private-null-'));
  try {
    const state=join(root,'state');const initialized=run('init','--data-dir',state);assert.equal(initialized.status,0,initialized.stderr);
    const credential=join(state,'agent.json');writeFileSync(credential,JSON.stringify({serverUrl:'http://127.0.0.1:1',deviceToken:'fixture'}));
    assert.equal(windowsAcl(credential,'null').nullDacl,true,'the fixture must have a real native null DACL');
    const result=run('agent','--credentials',credential);assert.notEqual(result.status,0);assert.match(result.stderr,/\[(null-dacl|foreign-access)\]/);
    assert.equal(run('protect','--data-dir',state).status,0);
    // Read only ACL metadata from a standard TrustedInstaller-owned OS file;
    // no privileged test account, OS ACL change, or file-content read is needed.
    const foreign=join(process.env.SystemRoot,'System32','kernel32.dll');const observed=windowsAcl(foreign);
    assert.ok(![observed.currentSid,'S-1-5-18','S-1-5-32-544'].includes(observed.owner),'the OS fixture must actually have a foreign owner');
    assert.throws(()=>assertPrivateFile(foreign),/\[unexpected-owner\]/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('Windows storage checks replacement rights above its immediate parent', {skip:process.platform!=='win32'},()=>{
  const root=mkdtempSync(join(tmpdir(),'jrc-private-ancestor-'));
  try {
    const state=join(root,'state');const nested=join(state,'engine');
    for(const dir of [state,nested]) {const result=run('init','--data-dir',dir);assert.equal(result.status,0,result.stderr);}
    const credential=join(nested,'agent.json');writeFileSync(credential,JSON.stringify({serverUrl:'http://127.0.0.1:1',deviceToken:'fixture'}));
    assert.match(run('agent','--credentials',credential).stderr,/Choose --workspace/);
    windowsAcl(root,'replaceable');
    assert.ok(!windowsAcl(state).rules.some(rule=>rule.allow&&rule.sid==='S-1-5-32-545'),'the protected immediate parent must remain private');
    const result=run('agent','--credentials',credential);assert.notEqual(result.status,0);assert.match(result.stderr,/\[unsafe-parent\]/);
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

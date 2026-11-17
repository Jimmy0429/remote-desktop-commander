import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

const repair = 'Use a new dedicated private state directory, or stop its processes and run protect --data-dir DIR on dedicated application state.';
const reasons=new Set(['permissions','helper-unavailable','helper-timeout','helper-response','helper-runtime','acl-query','acl-parse','null-dacl','unexpected-owner','foreign-access','unsafe-parent','reparse-path','nonlocal-filesystem','missing-parent','not-directory','not-file','create-directory','protect-state']);
const unavailable = (reason='permissions') => new Error(`Private storage permissions are unavailable or unsafe [${reasons.has(reason)?reason:'helper-runtime'}]. ${repair}`);

// Paths and operations arrive as JSON on stdin. No path, SID, or secret is
// interpolated into executable PowerShell. Only the inbox Windows PowerShell
// at an absolute system path is used; neither PATH nor the workspace is searched.
const aclScript = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$script:reason='helper-runtime'
try {
  # MCP clients may omit the warmed module-analysis cache environment. Import
  # trusted inbox manifests directly so command discovery cannot stall startup.
  $PSModuleAutoLoadingPreference='None'
  Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1')) -Force -ErrorAction Stop
  Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Management/Microsoft.PowerShell.Management.psd1')) -Force -ErrorAction Stop
  Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')) -Force -ErrorAction Stop
  $r=ConvertFrom-Json ([Console]::In.ReadToEnd())
  $user=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $trusted=@($user.Value,'S-1-5-18','S-1-5-32-544')
  $trustedInstaller='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
  $replacement=[long][Security.AccessControl.FileSystemRights]::Delete -bor [long][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [long][Security.AccessControl.FileSystemRights]::ChangePermissions -bor [long][Security.AccessControl.FileSystemRights]::TakeOwnership
  $danger=$replacement -bor [long][Security.AccessControl.FileSystemRights]::Write
  function Fail([string]$code) {$script:reason=$code;throw 'Private storage validation failed'}
  function NoReparse([string]$p) {
    $cursor=[IO.Path]::GetFullPath($p)
    if($cursor -notmatch '^[A-Za-z]:\\') {Fail 'nonlocal-filesystem'}
    while($cursor) {
      if(Test-Path -LiteralPath $cursor) {
        if(((Get-Item -Force -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {Fail 'reparse-path'}
      }
      $parent=[IO.Directory]::GetParent($cursor)
      if($null -eq $parent) {break};$cursor=$parent.FullName
    }
  }
  function CheckAcl([string]$p,[string]$scope='private') {
    NoReparse $p
    $script:reason='acl-query'
    $acl=Get-Acl -LiteralPath $p
    $script:reason='acl-parse'
    $raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
    if($null -eq $raw.DiscretionaryAcl) {Fail 'null-dacl'}
    $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    # An owner can rewrite the DACL even without an explicit replacement grant.
    # Only OS ancestors may additionally be owned/managed by TrustedInstaller.
    if($trusted -notcontains $owner -and -not ($scope -eq 'ancestor' -and $owner -eq $trustedInstaller)) {Fail 'unexpected-owner'}
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {continue}
      $sid=$rule.IdentityReference.Value
      if($trusted -contains $sid -or ($scope -eq 'ancestor' -and $sid -eq $trustedInstaller)) {continue}
      if($sid -eq 'S-1-3-0' -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) {continue}
      if($scope -eq 'ancestor' -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) {continue}
      if($scope -eq 'private') {Fail 'foreign-access'}
      $mask=if($scope -eq 'ancestor') {$replacement} else {$danger}
      if(([long]$rule.FileSystemRights -band $mask) -ne 0) {Fail 'unsafe-parent'}
    }
  }
  function CheckParent([string]$p) {
    $parent=[IO.Directory]::GetParent($p)
    while($null -ne $parent -and -not (Test-Path -LiteralPath $parent.FullName)) {$parent=$parent.Parent}
    if($null -eq $parent) {Fail 'missing-parent'}
    CheckAcl $parent.FullName 'parent'
    $parent=$parent.Parent
    while($null -ne $parent) {CheckAcl $parent.FullName 'ancestor';$parent=$parent.Parent}
  }
  function PrivateAcl([bool]$directory) {
    if($directory) {$acl=[Security.AccessControl.DirectorySecurity]::new()}
    else {$acl=[Security.AccessControl.FileSecurity]::new()}
    $acl.SetOwner($user);$acl.SetAccessRuleProtection($true,$false)
    foreach($id in $trusted) {
      $sid=[Security.Principal.SecurityIdentifier]::new($id)
      if($directory) {$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')}
      else {$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')}
      $acl.AddAccessRule($rule)
    }
    return $acl
  }
  $path=[IO.Path]::GetFullPath([string]$r.path)
  NoReparse $path
  if($r.action -eq 'directory') {
    CheckParent $path
    if(-not (Test-Path -LiteralPath $path)) {$script:reason='create-directory';[IO.Directory]::CreateDirectory($path,(PrivateAcl $true)) | Out-Null}
    if(-not (Get-Item -Force -LiteralPath $path).PSIsContainer) {Fail 'not-directory'}
    CheckAcl $path
  } elseif($r.action -eq 'file') {
    $parent=[IO.Path]::GetDirectoryName($path)
    CheckParent $parent;CheckAcl $parent
    if((Get-Item -Force -LiteralPath $path).PSIsContainer) {Fail 'not-file'}
    CheckAcl $path
  } elseif($r.action -eq 'protect') {
    CheckParent $path
    foreach($entry in $r.entries) {NoReparse ([string]$entry)}
    foreach($entry in $r.entries) {
      $script:reason='protect-state'
      $item=Get-Item -Force -LiteralPath ([string]$entry)
      Set-Acl -LiteralPath $item.FullName -AclObject (PrivateAcl $item.PSIsContainer)
    }
    foreach($entry in $r.entries) {CheckAcl ([string]$entry)}
  } else {throw 'Invalid operation'}
  [Console]::Out.Write('{"ok":true}')
} catch {[Console]::Out.Write('{"ok":false,"reason":"'+$script:reason+'"}');exit 1}
`;

function windowsAcl(action: 'directory'|'file'|'protect', path: string, entries?: string[]): void {
  for(let cursor=resolve(path);;cursor=dirname(cursor)) {
    try {if(lstatSync(cursor).isSymbolicLink()) throw unavailable('reparse-path');}
    catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
    if(cursor===dirname(cursor)) break;
  }
  const systemRoot=process.env.SystemRoot;
  if(!systemRoot || !/^[a-z]:[\\/]/i.test(systemRoot)) throw unavailable('helper-unavailable');
  const executable=join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  // A parent pwsh process can pass its incompatible module directory to 5.1.
  // Also exclude user/workspace modules from this security-sensitive subprocess.
  const environment=Object.fromEntries(Object.entries(process.env).filter(([name])=>name.toLowerCase()!=='psmodulepath'));
  environment.PSModulePath=join(dirname(executable),'Modules');
  const result=spawnSync(executable,['-NoProfile','-NonInteractive','-Command',aclScript],{
    input:JSON.stringify({action,path,entries}),env:environment,encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:64*1024,
  });
  if(result.error) throw unavailable((result.error as NodeJS.ErrnoException).code==='ETIMEDOUT'?'helper-timeout':'helper-unavailable');
  let response:{ok?:boolean;reason?:string};
  try {response=JSON.parse(result.stdout.replace(/^\uFEFF/,''));}
  catch {throw unavailable('helper-response');}
  if(!response || typeof response!=='object') throw unavailable('helper-response');
  if(result.status!==0 || response.ok!==true) throw unavailable(response.reason);
}

/** Create app-owned state privately; existing storage must already be private. */
export function ensurePrivateDirectory(directory: string): void {
  const path=resolve(directory);
  if(process.platform==='win32') {windowsAcl('directory',path);return;}
  if(!existsSync(path)) mkdirSync(path,{recursive:true,mode:0o700});
  const info=lstatSync(path);
  if(!info.isDirectory() || info.isSymbolicLink() || (info.mode&0o077) || (process.getuid && info.uid!==process.getuid())) throw unavailable();
}

/** Recheck the file and parent each read; a prior successful check is not cached. */
export function assertPrivateFile(file: string): void {
  const path=resolve(file);const info=lstatSync(path);
  if(!info.isFile() || info.isSymbolicLink()) throw unavailable();
  if(process.platform==='win32') {windowsAcl('file',path);return;}
  ensurePrivateDirectory(dirname(path));
  if((info.mode&0o077) || (process.getuid && info.uid!==process.getuid())) throw unavailable();
}

export function writePrivateFile(file: string, content: string, exclusive=true): void {
  const path=resolve(file);ensurePrivateDirectory(dirname(path));
  if(!exclusive) assertPrivateFile(path);
  writeFileSync(path,content,{flag:exclusive?'wx':'w',mode:0o600});
  assertPrivateFile(path);
}

const stateFiles=/^(?:owner-token|agent\.json|pairing-code|registry\.json(?:\.[a-f0-9]+\.tmp)?|server\.lock|server-lock\.sqlite(?:-journal|-wal|-shm)?|server-lock-migration-[a-f0-9-]+\.tmp|config\.json(?:\.[a-zA-Z0-9_.-]+)?|tool-history\.jsonl|claude_tool_call\.log|feature-flags\.json|fuzzy-search\.log)$/;
const stateDirectories=new Set(['server','engine','state','logs','config.json.lock']);

/** Explicit repair is restricted to recognizable app state, never general folders. */
export function protectPrivateDirectory(directory: string): void {
  const path=resolve(directory);const info=lstatSync(path);
  if(!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
  const compare=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
  const canonical=compare(realpathSync(path));
  const forbidden=[parse(canonical).root,compare(realpathSync(homedir())),compare(realpathSync(process.cwd()))];
  if(forbidden.some(value=>{
    const child=relative(canonical,value);
    return child==='' || (!isAbsolute(child) && child!=='..' && !child.startsWith('..'+sep));
  })) {
    throw new Error('Protect requires a dedicated application-state directory, not a volume, home, workspace, or repository.');
  }
  const entries:string[]=[];
  const inspect=(current:string)=>{
    if(entries.length>=4096) throw new Error('Too many state entries to protect safely.');
    const currentInfo=lstatSync(current);
    if(currentInfo.isSymbolicLink() || (!currentInfo.isDirectory()&&!currentInfo.isFile())) throw unavailable();
    entries.push(current);
    if(currentInfo.isDirectory()) for(const name of readdirSync(current)) {
      const child=join(current,name);const childInfo=lstatSync(child);
      if(childInfo.isDirectory()? !stateDirectories.has(name): !stateFiles.test(name)) {
        throw new Error('Protect refused unrelated files. Use a new dedicated private state directory and move only application state into it.');
      }
      inspect(child);
    }
  };
  inspect(path);
  if(process.platform==='win32') windowsAcl('protect',path,entries);
  else {
    for(const entry of entries) chmodSync(entry,lstatSync(entry).isDirectory()?0o700:0o600);
    ensurePrivateDirectory(path);
    for(const entry of entries) if(lstatSync(entry).isFile()) assertPrivateFile(entry);
  }
}

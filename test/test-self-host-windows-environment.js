import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {writePrivateFile} from '../dist/self-host/private-storage.js';

test('Windows private credential checks work in an MCP client filtered environment', {skip:process.platform!=='win32',timeout:45000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'jrc-environment-'));
  try {
    const credential=join(root,'state','owner-token');writePrivateFile(credential,'synthetic-environment-fixture');
    const entry=join(root,'environment-probe.mjs');
    const storage=new URL('../dist/self-host/private-storage.js',import.meta.url).href;
    // Instrument the real helper only in this disposable child. Fixed markers
    // expose no credential, ACL contents, account IDs, file paths, or env values.
    writeFileSync(entry,`
      import cp from 'node:child_process';
      import {syncBuiltinESMExports} from 'node:module';
      const original=cp.spawnSync;
      cp.spawnSync=(file,args,options)=>{
        const index=args.indexOf('-Command');
        const changed=[...args];
        const marker=phase=>"[Console]::Error.WriteLine('JRC_ACL_PHASE:"+phase+"')\\n";
        const modules=process.argv[3]==='import-inbox'
          ? ['Utility','Management','Security'].map(name=>marker(name.toLowerCase()+'-import-start')+"Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell."+name+"/Microsoft.PowerShell."+name+".psd1')) -Force\\n"+marker(name.toLowerCase()+'-import-done')).join('')
          : '';
        changed[index+1]=marker('script-start')+modules+changed[index+1]
          .replace("[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)",marker('input-encoding-start')+"[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)\\n"+marker('input-encoding-done'))
          .replace("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",marker('output-encoding-start')+"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\\n"+marker('output-encoding-done'))
          .replace("$r=ConvertFrom-Json ([Console]::In.ReadToEnd())",marker('stdin-start')+"$payload=[Console]::In.ReadToEnd()\\n"+marker('stdin-read-done')+"$r=ConvertFrom-Json $payload\\n"+marker('json-parse-done'))
          .replace("$user=[Security.Principal.WindowsIdentity]::GetCurrent().User",marker('identity-start')+"$user=[Security.Principal.WindowsIdentity]::GetCurrent().User\\n"+marker('identity-done'))
          .replace("$acl=Get-Acl -LiteralPath $p",marker('acl-query-start')+"$acl=Get-Acl -LiteralPath $p\\n"+marker('acl-query-done'));
        const result=original(file,changed,{...options,timeout:6000});
        const phases=[...String(result.stderr||'').matchAll(/JRC_ACL_PHASE:([a-z-]+)/g)].map(value=>value[1]);
        process.stdout.write(JSON.stringify({kind:'helper',phases,error:result.error?.code||null,status:result.status})+'\\n');
        return result;
      };
      syncBuiltinESMExports();
      const {assertPrivateFile}=await import(${JSON.stringify(storage)});
      try {assertPrivateFile(process.argv[2]);process.stdout.write(JSON.stringify({kind:'result',ok:true})+'\\n');}
      catch(error) {process.stdout.write(JSON.stringify({kind:'result',ok:false,reason:/\\[([a-z-]+)\\]/.exec(error.message)?.[1]||'other'})+'\\n');process.exitCode=1;}
    `);
    const filtered=getDefaultEnvironment();
    // The previous native run ruled out detached console/closed parent stdin
    // and each common Windows environment add-back. Keep only the failing
    // environment and one explicit inbox-module import to separate JSON work.
    const variants=[['full',process.env],['sdk',filtered],['sdk-inbox-modules',filtered,'import-inbox']];
    const cacheKey=Object.keys(process.env).find(key=>key.toLowerCase()==='psmoduleanalysiscachepath');
    if(cacheKey)variants.push(['sdk-analysis-cache',{...filtered,PSModuleAnalysisCachePath:process.env[cacheKey]}]);
    const reports=[];
    for(const [name,env,variant] of variants) {
      const start=performance.now();
      const result=await new Promise(resolve=>{
        const child=spawn(process.execPath,[entry,credential,variant||'baseline'],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
        let stdout='';let processError=null;
        const timer=setTimeout(()=>{processError='ETIMEDOUT';child.kill();},10000);
        child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.resume();
        child.stdin.on('error',()=>{});
        child.on('error',error=>{processError=error.code||'spawn-error';});
        child.on('close',status=>{clearTimeout(timer);child.stdin.destroy();resolve({stdout,status,processError});});
      });
      const events=[];
      for(const line of String(result.stdout||'').split(/\r?\n/)) {try{events.push(JSON.parse(line));}catch{/* Never emit raw subprocess output. */}}
      const report={name,elapsedMs:Math.round(performance.now()-start),status:result.status,processError:result.processError,
        phases:events.find(event=>event.kind==='helper')?.phases||[],helperError:events.find(event=>event.kind==='helper')?.error||null,
        ok:events.find(event=>event.kind==='result')?.ok===true,reason:events.find(event=>event.kind==='result')?.reason||null};
      reports.push(report);t.diagnostic(JSON.stringify(report));
    }
    assert.equal(reports.find(report=>report.name==='full').ok,true,'full environment control must succeed');
    assert.equal(reports.find(report=>report.name==='sdk').ok,true,'MCP-filtered launch must preserve private credential validation');
  } finally {rmSync(root,{recursive:true,force:true});}
});

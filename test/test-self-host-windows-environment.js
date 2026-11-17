import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {writePrivateFile} from '../dist/self-host/private-storage.js';

test('Windows private credential checks work with MCP filtered environment and disabled module cache', {skip:process.platform!=='win32',timeout:90000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'jrc-environment-'));
  try {
    const credential=join(root,'state','owner-token');writePrivateFile(credential,'synthetic-environment-fixture');
    const entry=join(root,'environment-probe.mjs');
    const storage=new URL('../dist/self-host/private-storage.js',import.meta.url).href;
    writeFileSync(entry,`
      import cp from 'node:child_process';
      import {syncBuiltinESMExports} from 'node:module';
      if(process.argv[3]==='sdk-missing-module') {
        const original=cp.spawnSync;
        cp.spawnSync=(file,args,options)=>{
          const changed=[...args];const index=changed.indexOf('-Command');
          changed[index+1]=changed[index+1].replace('Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1','Modules/JRC-Intentionally-Missing-Module-54b72d9a/Utility.psd1');
          return original(file,changed,options);
        };
        syncBuiltinESMExports();
      }
      const {assertPrivateFile}=await import(${JSON.stringify(storage)});
      try {assertPrivateFile(process.argv[2]);process.stdout.write(JSON.stringify({ok:true}));}
      catch(error) {process.stdout.write(JSON.stringify({ok:false,reason:/\\[([a-z-]+)\\]/.exec(error.message)?.[1]||'other'}));process.exitCode=1;}
    `);
    const filtered=getDefaultEnvironment();
    // The private helper uses its real production timeout. Neither case can
    // depend on the parent shell's warm PowerShell module-analysis cache.
    const uncached={...filtered,PSModuleAnalysisCachePath:'NUL'};
    const variants=[['sdk',filtered],['sdk-cache-disabled',uncached],['sdk-missing-module',uncached]];
    for(const [name,env] of variants) {
      const result=await new Promise(resolve=>{
        // Keep stdin open, as an MCP client does while waiting for initialize.
        const child=spawn(process.execPath,[entry,credential,name],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
        let stdout='';let processError=null;
        const timer=setTimeout(()=>{processError='ETIMEDOUT';child.kill();},25000);
        child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.resume();
        child.stdin.on('error',()=>{});
        child.on('error',error=>{processError=error.code||'spawn-error';});
        child.on('close',status=>{clearTimeout(timer);child.stdin.destroy();resolve({stdout,status,processError});});
      });
      let report={ok:false,reason:'invalid-result'};
      try {report=JSON.parse(result.stdout);}catch{/* Never emit raw subprocess output. */}
      const diagnostic={name,status:result.status,processError:result.processError,ok:report.ok===true,reason:report.reason||null};
      t.diagnostic(JSON.stringify(diagnostic));
      const expected=name==='sdk-missing-module'
        ? {name,status:1,processError:null,ok:false,reason:'helper-runtime'}
        : {name,status:0,processError:null,ok:true,reason:null};
      assert.deepEqual(diagnostic,expected,'private checks must succeed without a cache, or fail closed with a safe reason when an inbox module is unavailable');
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});

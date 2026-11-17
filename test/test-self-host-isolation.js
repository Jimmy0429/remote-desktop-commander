import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

test('self-host configuration, history and logs are isolated and omit call payloads', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'jrc-isolation-'));
  try {
    const script = `
      const {CONFIG_FILE, TOOL_CALL_FILE} = await import('./dist/config.js');
      const {join} = await import('node:path');
      if (CONFIG_FILE !== join(process.env.JRC_CONFIG_DIR, 'config.json')) throw new Error('Fork config is not isolated');
      const {toolHistory} = await import('./dist/utils/toolHistory.js');
      const {trackToolCall} = await import('./dist/utils/trackTools.js');
      toolHistory.addCall('write_file', {content:'PRIVATE-PAYLOAD'}, {content:[{type:'text',text:'PRIVATE-RESULT'}]}, 1);
      await toolHistory.cleanup();
      await trackToolCall('write_file', {content:'PRIVATE-PAYLOAD'});
      console.log(JSON.stringify({CONFIG_FILE, TOOL_CALL_FILE}));
    `;
    const {stdout} = await run(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, env: {...process.env, JRC_CONFIG_DIR:state, JRC_SELF_HOSTED:'1'}, timeout:10000
    });
    const paths = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(paths.CONFIG_FILE, path.join(state,'config.json'));
    assert.equal(paths.TOOL_CALL_FILE, path.join(state,'claude_tool_call.log'));
    const history = await readFile(path.join(state,'tool-history.jsonl'),'utf8');
    const log = await readFile(paths.TOOL_CALL_FILE,'utf8');
    assert.match(history, /write_file/);
    assert.doesNotMatch(history + log, /PRIVATE-PAYLOAD|PRIVATE-RESULT/);
  } finally { await rm(state,{recursive:true,force:true}); }
});

test('self-host feature flags do not fetch vendor or cached remote configuration', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'jrc-flags-'));
  try {
    const script = `
      let fetches = 0;
      globalThis.fetch = async () => { fetches++; return {ok:true,json:async()=>({flags:{externalFlag:true}})}; };
      const {featureFlagManager} = await import('./dist/utils/feature-flags.js');
      await featureFlagManager.initialize();
      await featureFlagManager.waitForFreshFlags();
      await featureFlagManager.refresh();
      featureFlagManager.destroy();
      console.log(JSON.stringify({fetches,flag:featureFlagManager.get('externalFlag',false)}));
    `;
    const {stdout} = await run(process.execPath, ['--input-type=module','-e',script], {
      cwd:root,env:{...process.env,JRC_CONFIG_DIR:state,JRC_SELF_HOSTED:'1'},timeout:10000
    });
    assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)),{fetches:0,flag:false});
  } finally { await rm(state,{recursive:true,force:true}); }
});

test('real self-host engine startup performs no HTTP requests or vendor telemetry', {timeout:20000}, async () => {
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'jrc-no-network-')));
  const state=path.join(base,'state');
  const workspace=path.join(base,'workspace');
  const guard=path.join(base,'network-guard.mjs');
  const attempts=path.join(base,'attempts.txt');
  await mkdir(workspace);
  try {
    await writeFile(guard,`
      import http from 'node:http';
      import https from 'node:https';
      import {appendFileSync} from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const fail=()=>{appendFileSync(${JSON.stringify(attempts)},'network attempted\\n');throw new Error('Unexpected startup network');};
      globalThis.fetch=fail;
      http.request=fail; http.get=fail; https.request=fail; https.get=fail;
      syncBuiltinESMExports();
    `);
    const script=`
      const {LocalEngine}=await import('./dist/self-host/local-engine.js');
      const engine=new LocalEngine({stateDir:${JSON.stringify(state)},workspace:${JSON.stringify(workspace)}});
      try { await engine.start(); await engine.call('get_config',{}); await new Promise(r=>setTimeout(r,150)); }
      finally { await engine.close(); }
    `;
    await run(process.execPath,['--input-type=module','-e',script],{
      cwd:root,env:{...process.env,NODE_OPTIONS:`--import=${pathToFileURL(guard).href}`},timeout:15000
    });
    const observed=await readFile(attempts,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
    assert.equal(observed,'');
  } finally { await rm(base,{recursive:true,force:true}); }
});

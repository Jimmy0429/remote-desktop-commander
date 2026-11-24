import { VERSION } from '../version.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MAX_MESSAGE_BYTES, REMOTE_TOOL_NAMES, ENGINE_CALL_TIMEOUT_MS } from './protocol.js';
import { ensurePrivateDirectory } from './private-storage.js';
import { EngineCallError } from './device-engine.js';
export { EngineCallError } from './device-engine.js';

export interface EngineOptions { stateDir:string; workspace:string; }

/** Each device owns one upstream stdio process; no upstream globals enter the relay. */
export class LocalEngine {
  private client?: Client;
  private transport?: StdioClientTransport;
  private tools?: Tool[];
  private starting?: Promise<Tool[]>;
  private closing?: Promise<void>;
  private closed = false;
  private disconnect?: () => void;
  constructor(private readonly options:EngineOptions) {}
  onDisconnect(callback:()=>void):void { this.disconnect=callback; }
  start():Promise<Tool[]> {
    if(this.closed) return Promise.reject(new Error('Local engine is closed'));
    if(this.tools) return Promise.resolve(this.tools);
    this.starting ??= this.initialize().finally(()=>{this.starting=undefined;});
    return this.starting;
  }
  private async initialize():Promise<Tool[]> {
    const state = path.resolve(this.options.stateDir);
    const workspace = await realpath(path.resolve(this.options.workspace));
    if(!(await stat(workspace)).isDirectory()) throw new Error('Workspace must be a directory');
    ensurePrivateDirectory(state);
    const stateDir=await realpath(state);
    if(this.closed) throw new Error('Local engine is closed');
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));
    // Keep the real user home; only the fork's own configuration is redirected.
    const transport = new StdioClientTransport({
      command:process.execPath,args:[fileURLToPath(new URL('../index.js',import.meta.url)),'--no-onboarding'],
      // ReadBuffer checks an entire pipe chunk before extracting complete lines.
      // Leave headroom for a bounded response coalesced with the next message.
      cwd:workspace,stderr:'pipe',maxBufferSize:2*MAX_MESSAGE_BYTES,
      env:{...environment,JRC_CONFIG_DIR:stateDir,JRC_WORKSPACE:workspace,JRC_SELF_HOSTED:'1',
        DESKTOP_COMMANDER_DISABLE_TELEMETRY:'1',DC_REMOTE_DEVICE:'true'},
    });
    // Drain diagnostics without persisting file contents, command arguments, or credentials.
    transport.stderr?.on('data',()=>{});
    const client=new Client({name:'jimmy-remote-commander-agent',version:VERSION},{capabilities:{}});
    this.transport=transport;
    this.client=client;
    client.onclose=()=>{
      this.tools=undefined;
      this.client=undefined;
      if(!this.closed) this.disconnect?.();
    };
    client.onerror=()=>{};
    try {
      await client.connect(transport,{timeout:15000});
      const {tools}=await client.listTools(undefined,{timeout:15000});
      if(this.closed) throw new Error('Local engine is closed');
      const allowed=new Set<string>(REMOTE_TOOL_NAMES);
      this.tools=tools.filter(tool=>allowed.has(tool.name));
      return this.tools;
    } catch(error) {
      await transport.close();
      this.client=undefined;
      throw error;
    }
  }
  async call(name:string,args:Record<string,unknown>):Promise<CallToolResult> {
    if(!this.client || !this.tools || this.closed) throw new EngineCallError('Local engine is not running; the call was not started.','not_started');
    if(!this.tools.some(tool=>tool.name===name)) throw new EngineCallError('Tool is not allowed; the call was not started.','not_started');
    const result=await this.client.callTool({name,arguments:args,_meta:{remote:true}},CallToolResultSchema,{timeout:ENGINE_CALL_TIMEOUT_MS});
    if(Buffer.byteLength(JSON.stringify(result),'utf8')>MAX_MESSAGE_BYTES-1024) throw new EngineCallError('The operation completed, but its result exceeds the message limit. Request a smaller output; do not repeat a write or command solely to recover its output.','completed');
    return CallToolResultSchema.parse(result);
  }
  close():Promise<void> {
    if(this.closing) return this.closing;
    this.closed=true;
    this.closing=(async()=>{
      // Closing the transport ends stdin and lets the child reap terminal/search jobs.
      await this.transport?.close();
      await this.starting?.catch(()=>{});
      await this.client?.close().catch(()=>{});
      this.client=undefined;
      this.tools=undefined;
      this.transport=undefined;
    })();
    return this.closing;
  }
}

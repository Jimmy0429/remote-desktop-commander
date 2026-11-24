import WebSocket from 'ws';
import { EngineCallError, type DeviceEngine } from './device-engine.js';
import { AGENT_CLOSE_CODES, MAX_MESSAGE_BYTES, parseServerMessage, safeRemoteUrl, type AgentMessage } from './protocol.js';

export interface AgentStatus {
  state:'connecting'|'retrying'|'connected';
  message:string;
  retryDelayMs?:number;
}
export interface AgentExit {
  reason:'requested'|'authorization'|'replaced'|'protocol'|'engine';
  message:string;
  exitCode:0|1;
}
export interface AgentConnectionOptions {
  serverUrl:string;
  deviceToken:string;
  signal?:AbortSignal;
  onStatus?:(status:AgentStatus)=>void;
}
export interface AgentHandle {close():Promise<void>;closed:Promise<AgentExit>;}

/** Resolves at first readiness; transient connection failures retry until stopped. */
export async function connectAgent(options:AgentConnectionOptions, createEngine:()=>DeviceEngine):Promise<AgentHandle> {
  const url=safeRemoteUrl(options.serverUrl);
  if(!options.deviceToken || /[\r\n]/.test(options.deviceToken)) throw new Error('Invalid device credential');
  url.pathname='/agent';
  url.protocol=url.protocol==='https:'?'wss:':'ws:';
  let stopped=false;
  let connectedBefore=false;
  let attempting=false;
  let current:WebSocket|undefined;
  let engine:DeviceEngine|undefined;
  let retiring=Promise.resolve();
  let reconnectTimer:NodeJS.Timeout|undefined;
  let heartbeat:NodeJS.Timeout|undefined;
  let attempts=0;
  let accessPolicyAttempts=0;
  let accessPolicyRejected=false;
  let activeCalls=0;
  let closing:Promise<void>|undefined;
  const seen=new Map<string,boolean>();
  let resolveReady!:()=>void;
  let rejectReady!:(error:Error)=>void;
  let resolveClosed!:(exit:AgentExit)=>void;
  const ready=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const closed=new Promise<AgentExit>(resolve=>{resolveClosed=resolve;});
  const report=(status:AgentStatus)=>{try{options.onStatus?.(status);}catch{/* Observer failures cannot change execution. */}};

  const stop=(exit:AgentExit):Promise<void>=>{
    if(closing) return closing;
    stopped=true;
    clearTimeout(reconnectTimer);
    clearTimeout(heartbeat);
    options.signal?.removeEventListener('abort',abort);
    const error=new Error(exit.message);
    if(exit.reason==='requested') error.name='AbortError';
    rejectReady(error);
    closing=(async()=>{
      current?.terminate();
      current=undefined;
      try {await Promise.all([engine?.close(),retiring]);}
      catch {exit={reason:'engine',message:'Agent stopped but the local tool engine could not be cleanly closed.',exitCode:1};}
      engine=undefined;
      resolveClosed(exit);
    })();
    return closing;
  };
  const close=()=>stop({reason:'requested',message:'Agent disconnected by request.',exitCode:0});
  function abort():void {void close();}
  const fatal=(reason:Exclude<AgentExit['reason'],'requested'>,message:string)=>stop({reason,message,exitCode:1});
  const authorizationFailure=()=>fatal('authorization','Device authorization was rejected or revoked. Enroll again before restarting.');

  const send=(socket:WebSocket,message:AgentMessage)=>{
    if(stopped || current!==socket || socket.readyState!==WebSocket.OPEN) return;
    const text=JSON.stringify(message);
    if(Buffer.byteLength(text)>MAX_MESSAGE_BYTES || socket.bufferedAmount>MAX_MESSAGE_BYTES) {
      socket.close(1009,'Message limit');
      return;
    }
    socket.send(text,()=>{});
  };
  const schedule=()=>{
    if(stopped || reconnectTimer) return;
    const delay=accessPolicyRejected
      ? Math.min(300000,5000*2**Math.min(accessPolicyAttempts++,6))
      : Math.min(10000,250*2**Math.min(attempts++,6)*(0.8+Math.random()*0.4));
    report({state:'retrying',message:accessPolicyRejected
      ? 'HTTP 403 access policy rejected the connection. Check the server host, proxy, or VPN policy; retrying automatically.'
      : 'Server connection unavailable; retrying automatically.',retryDelayMs:Math.ceil(delay)});
    if(stopped) return;
    reconnectTimer=setTimeout(()=>{reconnectTimer=undefined;void attempt();},delay);
  };
  const connect=async():Promise<void>=>{
    await retiring;
    if(stopped) return;
    report({state:'connecting',message:'Connecting device to server.'});
    if(!engine) {
      const next=createEngine();
      engine=next;
      next.onDisconnect?.(()=>{
        if(engine!==next || stopped) return;
        engine=undefined;
        retiring=next.close().catch(()=>{});
        current?.terminate();
      });
    }
    let tools;
    try {tools=await engine.start();}
    catch(error) {
      await engine?.close();engine=undefined;
      if(!connectedBefore && !stopped) await fatal('engine','Local tool engine failed to start. Check the workspace, state directory, and installation before restarting.');
      throw error;
    }
    if(stopped) return;
    const activeEngine=engine;
    const socket=new WebSocket(url,{headers:{Authorization:'Bearer '+options.deviceToken},
      maxPayload:MAX_MESSAGE_BYTES,followRedirects:false,handshakeTimeout:10000,perMessageDeflate:false});
    accessPolicyRejected=false;
    current=socket;
    let opened=false;
    const touch=()=>{
      if(stopped || current!==socket) return;
      clearTimeout(heartbeat);
      heartbeat=setTimeout(()=>socket.terminate(),75000);
    };
    socket.on('ping',touch);
    socket.on('error',()=>{});
    socket.on('message',(raw,isBinary)=>{
      if(stopped || current!==socket) return;
      touch();
      let request;
      try {
        if(isBinary) throw new Error('Text messages required');
        request=parseServerMessage(raw.toString());
      } catch {void fatal('protocol','Server sent an invalid protocol message. Agent disconnected.');return;}
      if(seen.has(request.id)) {
        send(socket,{type:'error',id:request.id,execution:'unknown',code:'duplicate_call',message:'Duplicate call refused; no replay performed'});
        return;
      }
      if(activeCalls>=8) {
        send(socket,{type:'error',id:request.id,execution:'not_started',message:'Device concurrency limit reached; call not started'});
        return;
      }
      // Retain the last 4096 IDs across reconnects, never evicting an in-flight call.
      if(seen.size>=4096) for(const [id,inFlight] of seen) {if(!inFlight){seen.delete(id);break;}}
      seen.set(request.id,true);
      activeCalls++;
      const id=request.id;
      void activeEngine!.call(request.name,request.arguments).then(
        result=>send(socket,{type:'result',id,result}),
        error=>send(socket,error instanceof EngineCallError
          ? {type:'error',id,execution:error.execution,message:error.message}
          : {type:'error',id,execution:'unknown',message:'Local tool failed; execution outcome may be unknown. Do not automatically retry.'}),
      ).finally(()=>{activeCalls--;seen.set(id,false);});
    });
    socket.on('close',(code)=>{
      if(current!==socket) return;
      current=undefined;
      clearTimeout(heartbeat);
      if(code===AGENT_CLOSE_CODES.REPLACED) {
        void fatal('replaced','Device connection was replaced by another agent using the same credentials. Stop the duplicate agent or enroll this computer separately.');
      } else if(code===AGENT_CLOSE_CODES.REVOKED) {
        void authorizationFailure();
      } else if(code===1008) {
        void fatal('protocol','Server closed this device for an authorization or protocol violation. Check enrollment before restarting.');
      } else if(opened) schedule();
    });
    await new Promise<void>((resolve,reject)=>{
      socket.once('unexpected-response',(_request,response)=>{
        const status=response.statusCode||0;
        response.resume();
        if(status===401) void authorizationFailure();
        else if(status===403) accessPolicyRejected=true;
        else if(status>=300 && status<500 && status!==408 && status!==429) {
          void fatal('protocol','Server rejected the agent endpoint. Check the server URL and protocol compatibility.');
        }
        socket.terminate();
        reject(new Error('Device connection failed'));
      });
      socket.once('error',()=>reject(new Error('Device connection failed')));
      socket.once('close',()=>reject(new Error('Device connection closed before ready')));
      socket.once('open',()=>{
        if(stopped) {socket.terminate();reject(new Error('Agent closed'));return;}
        opened=true;
        attempts=0;
        accessPolicyAttempts=0;
        accessPolicyRejected=false;
        connectedBefore=true;
        touch();
        send(socket,{type:'ready',tools});
        report({state:'connected',message:'Device connected. Keep this process running; press Ctrl+C to disconnect.'});
        resolveReady();
        resolve();
      });
    });
  };
  async function attempt():Promise<void> {
    if(stopped || attempting) return;
    attempting=true;
    try {await connect();}
    catch {schedule();}
    finally {attempting=false;}
  }
  options.signal?.addEventListener('abort',abort,{once:true});
  if(options.signal?.aborted) abort();
  else void attempt();
  try {await ready;return {close,closed};}
  catch(error) {await closed;throw error;}
}

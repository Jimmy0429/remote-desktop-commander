import WebSocket from 'ws';
import { LocalEngine, type EngineOptions } from './local-engine.js';
import { MAX_MESSAGE_BYTES, parseServerMessage, safeRemoteUrl, type AgentMessage } from './protocol.js';

export interface AgentOptions extends EngineOptions { serverUrl:string; deviceToken:string; }
export async function startAgent(options:AgentOptions):Promise<{close():Promise<void>}> {
  const url=safeRemoteUrl(options.serverUrl);
  if(!options.deviceToken || /[\r\n]/.test(options.deviceToken)) throw new Error('Invalid device credential');
  url.pathname='/agent';
  url.protocol=url.protocol==='https:'?'wss:':'ws:';
  let stopped=false;
  let current:WebSocket|undefined;
  let engine:LocalEngine|undefined;
  let reconnectTimer:NodeJS.Timeout|undefined;
  let heartbeat:NodeJS.Timeout|undefined;
  let attempts=0;
  let activeCalls=0;
  let closing:Promise<void>|undefined;
  const seen=new Map<string,boolean>();
  const send=(socket:WebSocket,message:AgentMessage)=>{
    if(stopped || current!==socket || socket.readyState!==WebSocket.OPEN) return;
    const text=JSON.stringify(message);
    if(Buffer.byteLength(text)>MAX_MESSAGE_BYTES || socket.bufferedAmount>MAX_MESSAGE_BYTES) {
      socket.close(1009,'Message limit');
      return;
    }
    socket.send(text,()=>{});
  };
  const close=():Promise<void>=>{
    if(closing) return closing;
    stopped=true;
    clearTimeout(reconnectTimer);
    clearTimeout(heartbeat);
    closing=(async()=>{
      current?.terminate();
      current=undefined;
      await engine?.close();
      engine=undefined;
    })();
    return closing;
  };
  const schedule=()=>{
    if(stopped || reconnectTimer) return;
    const delay=Math.min(10000,250*2**Math.min(attempts++,6))*(0.8+Math.random()*0.4);
    reconnectTimer=setTimeout(()=>{
      reconnectTimer=undefined;
      void connect().catch(()=>schedule());
    },delay);
  };
  const connect=async():Promise<void>=>{
    if(stopped) return;
    if(!engine) {
      const next=new LocalEngine(options);
      engine=next;
      next.onDisconnect(()=>{
        if(engine!==next || stopped) return;
        engine=undefined;
        void next.close();
        current?.terminate();
      });
    }
    let tools;
    try { tools=await engine.start(); }
    catch(error) { await engine?.close(); engine=undefined; throw error; }
    if(stopped) return;
    const activeEngine=engine;
    const socket=new WebSocket(url,{headers:{Authorization:`Bearer ${options.deviceToken}`},
      maxPayload:MAX_MESSAGE_BYTES,followRedirects:false,handshakeTimeout:10000,perMessageDeflate:false});
    current=socket;
    const touch=()=>{
      clearTimeout(heartbeat);
      heartbeat=setTimeout(()=>socket.terminate(),75000);
    };
    socket.on('ping',touch);
    // A later socket failure must remain handled after the handshake promise has settled.
    socket.on('error',()=>{});
    socket.on('message',(raw,isBinary)=>{
      touch();
      let request;
      try {
        if(isBinary) throw new Error('Text messages required');
        request=parseServerMessage(raw.toString());
      } catch { socket.close(1008,'Invalid protocol message'); return; }
      if(seen.has(request.id)) { send(socket,{type:'error',id:request.id,message:'Duplicate call refused; no replay performed'}); return; }
      if(activeCalls>=8) { send(socket,{type:'error',id:request.id,message:'Device concurrency limit reached; call not started'}); return; }
      // The relay generates random IDs; retain the last 4096 for duplicate rejection across reconnects.
      if(seen.size>=4096) {
        // Never evict an in-flight ID, even if a slow call spans thousands of later calls.
        for(const [id,inFlight] of seen) { if(!inFlight) { seen.delete(id); break; } }
      }
      seen.set(request.id,true);
      activeCalls++;
      const id=request.id;
      void activeEngine!.call(request.name,request.arguments).then(
        result=>send(socket,{type:'result',id,result}),
        ()=>send(socket,{type:'error',id,message:'Local tool failed; execution outcome may be unknown. Do not automatically retry.'}),
      ).finally(()=>{activeCalls--;seen.set(id,false);});
    });
    socket.on('close',(code)=>{
      if(current!==socket) return;
      current=undefined;
      clearTimeout(heartbeat);
      if(code===1008) { void close(); return; }
      schedule();
    });
    await new Promise<void>((resolve,reject)=>{
      socket.once('unexpected-response',(_request,response)=>{
        const unauthorized=response.statusCode===401 || response.statusCode===403;
        response.resume();
        if(unauthorized) void close();
        socket.terminate();
        reject(new Error(unauthorized ? 'Device authorization rejected; enroll again before restarting' : 'Device connection failed'));
      });
      socket.once('error',()=>reject(new Error('Device connection failed')));
      socket.once('close',()=>reject(new Error('Device connection closed before ready')));
      socket.once('open',()=>{
        if(stopped) { socket.terminate(); reject(new Error('Agent closed')); return; }
        attempts=0;
        touch();
        send(socket,{type:'ready',tools});
        resolve();
      });
    });
  };
  try { await connect(); }
  catch(error) { await close(); throw error; }
  return {close};
}

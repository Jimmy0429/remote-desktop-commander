import { randomUUID } from 'node:crypto';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type WebSocket from 'ws';
import type { DeviceRegistry } from './registry.js';
import { parseAgentMessage, MAX_MESSAGE_BYTES, REMOTE_TOOL_NAMES } from './protocol.js';

// Policy is owned by the operator, not remotely mutable through the AI tools.
export const REMOTE_TOOLS = new Set<string>(REMOTE_TOOL_NAMES);

type Status = 'running' | 'completed' | 'failed' | 'unknown';
interface Connection {
  socket: WebSocket; generation: string; ready: boolean; alive: boolean;
  tools: Tool[]; readyTimer: NodeJS.Timeout;
}
interface RemoteCall {
  id: string; deviceId: string; generation: string; tool: string; status: Status;
  startedAt: string; finishedAt?: string; result?: CallToolResult;
  done: Promise<void>; resolve: () => void; timer: NodeJS.Timeout;
}

const errorResult = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

export class Relay {
  private connections = new Map<string, Connection>();
  private calls = new Map<string, RemoteCall>();
  private heartbeat: NodeJS.Timeout;
  private sweep: NodeJS.Timeout;
  private closed = false;

  constructor(private registry: DeviceRegistry, private timeoutMs = 120_000, private waitMs = 3000) {
    this.heartbeat = setInterval(() => {
      for (const c of this.connections.values()) {
        if (!c.alive) { c.socket.terminate(); continue; }
        c.alive = false; c.socket.ping();
      }
    }, 15_000);
    this.sweep = setInterval(() => this.prune(), 30_000);
    this.heartbeat.unref(); this.sweep.unref();
  }

  attach(deviceId: string, socket: WebSocket): void {
    if (this.closed) { socket.terminate(); return; }
    this.disconnect(deviceId, 'Device reconnected; execution outcome is unknown.');
    const c: Connection = { socket, generation: randomUUID(), ready: false, alive: true, tools: [],
      readyTimer: setTimeout(() => socket.terminate(), 10_000) };
    this.connections.set(deviceId, c);
    socket.on('pong', () => { c.alive = true; });
    socket.on('message', (raw, binary) => {
      if (this.connections.get(deviceId) !== c) return;
      try {
        if (binary || Buffer.byteLength(raw.toString()) > MAX_MESSAGE_BYTES) throw new Error('Invalid payload');
        const message = parseAgentMessage(raw.toString());
        if (message.type === 'ready') {
          if (c.ready) throw new Error('Duplicate readiness');
          c.tools = message.tools.filter(t => REMOTE_TOOLS.has(t.name)).map(t => {
            const { _meta, ...tool } = t;
            return tool;
          });
          if (!c.tools.length) throw new Error('No supported tools');
          c.ready = true; clearTimeout(c.readyTimer);
          return;
        }
        if (!c.ready) throw new Error('Device is not ready');
        const call = this.calls.get(message.id);
        if (!call || call.deviceId !== deviceId || call.generation !== c.generation || call.status !== 'running') return;
        if (message.type === 'result') this.finish(call, message.result.isError ? 'failed' : 'completed', message.result);
        else this.finish(call, 'unknown', errorResult('Device could not confirm the result. Do not automatically retry; the operation may have executed.'));
      } catch { socket.close(1008, 'Invalid protocol message'); }
    });
    socket.on('error', () => { socket.terminate(); });
    socket.on('close', () => {
      clearTimeout(c.readyTimer);
      if (this.connections.get(deviceId) === c) this.disconnect(deviceId, 'Device disconnected; execution outcome is unknown.');
    });
  }

  devices() { return this.registry.list().map(d => ({ ...d, online: !d.revokedAt && !!this.connections.get(d.id)?.ready })); }

  catalog(): Tool[] {
    const catalog = new Map<string, Tool>();
    for (const c of this.connections.values()) if (c.ready) {
      for (const tool of c.tools) if (!catalog.has(tool.name)) catalog.set(tool.name, {
        ...tool,
        description: `${tool.description || tool.name}\nRuns on the device selected by deviceId.`,
        inputSchema: { ...tool.inputSchema, properties: {
          ...tool.inputSchema.properties,
          deviceId: { type: 'string', description: 'ID from list_devices. Select the intended computer explicitly.' },
        }, required: [...new Set([...(tool.inputSchema.required || []), 'deviceId'])] },
      });
    }
    return [...catalog.values()];
  }

  async call(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (this.closed) throw new Error('Server is shutting down.');
    this.prune();
    if (!REMOTE_TOOLS.has(tool)) throw new Error('This tool is not available remotely.');
    let deviceId = args.deviceId;
    if (deviceId === undefined) {
      const online = this.devices().filter(d => d.online);
      if (online.length !== 1) throw new Error('Select deviceId explicitly using list_devices; no unique online device.');
      deviceId = online[0].id;
    }
    if (typeof deviceId !== 'string') throw new Error('deviceId must be a string.');
    const connection = this.connections.get(deviceId);
    if (!connection?.ready || this.registry.list().find(d => d.id === deviceId)?.revokedAt) throw new Error('Selected device is offline or revoked.');
    if (!connection.tools.some(t => t.name === tool)) throw new Error('Selected device does not support this tool.');
    const running = [...this.calls.values()].filter(c => c.status === 'running');
    if (running.length >= 32 || running.filter(c => c.deviceId === deviceId).length >= 8) throw new Error('Too many active calls; wait for existing calls to complete.');
    const { deviceId: _deviceId, ...forwarded } = args;
    const id = randomUUID();
    const payload = JSON.stringify({ type: 'call', id, name: tool, arguments: forwarded });
    if (Buffer.byteLength(payload) > MAX_MESSAGE_BYTES) throw new Error('Tool arguments exceed the message limit.');
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    const call: RemoteCall = {
      id, deviceId, generation: connection.generation, tool, status: 'running',
      startedAt: new Date().toISOString(), done, resolve,
      timer: setTimeout(() => this.finish(call, 'unknown', errorResult('Timed out waiting for the device. The operation may still be running. Do not automatically retry.')), this.timeoutMs),
    };
    this.calls.set(id, call);
    try { this.audit(call); }
    catch { clearTimeout(call.timer); this.calls.delete(id); throw new Error('Unable to record the call; it was not sent.'); }
    try {
      connection.socket.send(payload, err => { if (err) this.finish(call, 'unknown', errorResult('Connection failed. Do not automatically retry; execution outcome is unknown.')); });
    } catch { this.finish(call, 'unknown', errorResult('Connection failed. Do not automatically retry; execution outcome is unknown.')); }
    let waitTimer: NodeJS.Timeout | undefined;
    await Promise.race([done, new Promise<void>(r => { waitTimer = setTimeout(r, this.waitMs); })]);
    if (waitTimer) clearTimeout(waitTimer);
    return call.status === 'running' ? this.snapshot(call) : call.result!;
  }

  poll(id: string): CallToolResult {
    this.prune();
    const call = this.calls.get(id);
    if (!call) return errorResult('Call not found or its retained result expired. Do not retry a side effect solely because its result is unavailable.');
    return this.snapshot(call);
  }

  disconnect(deviceId: string, reason = 'Device access revoked; execution outcome is unknown.'): void {
    const c = this.connections.get(deviceId);
    if (!c) return;
    this.connections.delete(deviceId); clearTimeout(c.readyTimer);
    c.socket.close(1000, 'Disconnected'); c.socket.terminate();
    for (const call of this.calls.values()) if (call.deviceId === deviceId && call.generation === c.generation && call.status === 'running') {
      this.finish(call, 'unknown', errorResult(`${reason} Do not automatically retry.`));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; clearInterval(this.heartbeat); clearInterval(this.sweep);
    for (const id of [...this.connections.keys()]) this.disconnect(id, 'Server stopped; execution outcome is unknown.');
  }

  private snapshot(c: RemoteCall): CallToolResult {
    return {
      ...(c.status === 'failed' || c.status === 'unknown' ? { isError: true } : {}),
      content: [{ type: 'text', text: c.status === 'running'
        ? `Call ${c.id} is still running. Use get_remote_call; do not submit the operation again.`
        : c.status === 'unknown' ? `Call ${c.id}: execution outcome is unknown. Do not automatically retry.` : `Call ${c.id}: ${c.status}. Result is in structuredContent.result.` }],
      structuredContent: { callId: c.id, deviceId: c.deviceId, tool: c.tool, status: c.status, ...(c.result ? { result: c.result } : {}) },
    };
  }

  private finish(call: RemoteCall, status: Status, result: CallToolResult): void {
    if (call.status !== 'running') return;
    clearTimeout(call.timer); call.status = status; call.finishedAt = new Date().toISOString(); call.result = result;
    try { this.audit(call); } catch { /* Do not lose a completed result because durable metadata failed. */ }
    call.resolve(); this.prune();
  }

  private audit(c: RemoteCall): void {
    this.registry.audit({ id: c.id, deviceId: c.deviceId, tool: c.tool, status: c.status,
      startedAt: c.startedAt, ...(c.finishedAt ? { finishedAt: c.finishedAt, durationMs: Date.parse(c.finishedAt) - Date.parse(c.startedAt) } : {}) });
  }

  private prune(): void {
    const now = Date.now(); let bytes = 0; let retained = 0;
    const entries = [...this.calls.values()].reverse();
    for (const c of entries) {
      if (c.status === 'running') continue;
      bytes += c.result ? Buffer.byteLength(JSON.stringify(c.result)) : 0; retained++;
      if (now - Date.parse(c.finishedAt!) > 600_000 || retained > 200 || bytes > 64 * 1024 * 1024) this.calls.delete(c.id);
    }
  }
}

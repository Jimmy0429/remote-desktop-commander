import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { MAX_MESSAGE_BYTES, safeRemoteUrl } from './protocol.js';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ACTIVE_REQUESTS = 8;
const MAX_PAYLOAD_BYTES = MAX_MESSAGE_BYTES - 1024;
const FAILED_CONNECTION = 'Remote MCP connection failed. An in-flight operation may have executed; inspect its state before retrying. The bridge did not retry the operation.';

export interface StdioBridgeOptions { serverUrl: string; ownerToken: string; }
export interface StdioBridgeExit { exitCode: 0 | 1; reason: 'closed' | 'transport_failed'; }
export interface StdioBridge { close(): Promise<void>; closed: Promise<StdioBridgeExit>; }

/** Connect a local MCP client to this private service without exposing a local port. */
export async function startStdioBridge(options: StdioBridgeOptions): Promise<StdioBridge> {
  const endpoint = new URL('/mcp', safeRemoteUrl(options.serverUrl));
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.ownerToken)) throw new Error('The private MCP credential is invalid.');
  const stopped = new AbortController();
  let finish!: (exit: StdioBridgeExit) => void;
  const closed = new Promise<StdioBridgeExit>(resolve => { finish = resolve; });
  let closing: Promise<void> | undefined;
  let ready = false;
  let active = 0;
  let remoteReady: Promise<void>;

  const remote = new Client({ name: 'jimmy-remote-commander-bridge', version: '0.1.0' });
  const local = new Server({ name: 'jimmy-remote-commander', version: '0.1.0' }, { capabilities: { tools: {} } });
  const stdio = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 2 * MAX_MESSAGE_BYTES });
  const http = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${options.ownerToken}` }, redirect: 'error' },
    // This service uses JSON responses and explicit call-ID polling, not replay.
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.href !== endpoint.href) throw new Error('Unexpected MCP destination.');
      if (typeof init?.body === 'string' && Buffer.byteLength(init.body) > MAX_MESSAGE_BYTES) throw new Error('MCP request exceeds the size limit.');
      const signal = AbortSignal.any([stopped.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(init?.signal ? [init.signal] : [])]);
      const response = await fetch(endpoint, { ...init, signal, redirect: 'error', credentials: 'omit' });
      // Buffer only a bounded JSON reply before the SDK parses it. A streaming
      // endpoint is outside this bridge's private-server contract.
      if (response.headers.get('content-type')?.split(';')[0].trim() === 'text/event-stream') {
        await response.body?.cancel();
        throw new Error('Unexpected streaming MCP response.');
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_MESSAGE_BYTES) throw new Error('MCP response exceeds the size limit.');
            chunks.push(chunk.value);
          }
        } catch (error) {
          await reader.cancel().catch(() => {});
          throw error;
        } finally { reader.releaseLock(); }
      }
      const headers = new Headers(response.headers);
      headers.delete('content-encoding'); headers.delete('content-length');
      return new Response(bytes ? Uint8Array.from(Buffer.concat(chunks)) : null, { status: response.status, statusText: response.statusText, headers });
    },
  });

  const close = (exitCode: 0 | 1 = 0): Promise<void> => {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      stopped.abort();
      process.stdin.off('end', onEnd); process.stdin.off('close', onEnd);
      process.stdout.off('error', onFailure);
      process.off('SIGINT', onEnd); process.off('SIGTERM', onEnd);
      await Promise.allSettled([local.close(), remote.close(), stdio.close(), http.close()]);
      finish({ exitCode, reason: exitCode ? 'transport_failed' : 'closed' });
    });
    return closing;
  };
  const onEnd = () => { void close(); };
  const onFailure = () => {
    if (closing) return;
    if (ready) process.stderr.write(FAILED_CONNECTION + '\n');
    void close(1);
  };
  const handle: StdioBridge = { close: () => close(), closed };
  remote.onclose = onFailure;
  // A failed HTTP request is not a closed transport. Keep stdio alive long
  // enough to return the sanitized request error, and allow explicit recovery
  // reads/polls later. The failed request is never submitted again.
  remote.onerror = () => { if (ready && !closing) process.stderr.write(FAILED_CONNECTION + '\n'); };
  local.onclose = onEnd; local.onerror = onFailure;
  process.stdin.once('end', onEnd); process.stdin.once('close', onEnd);
  process.stdout.once('error', onFailure);
  process.once('SIGINT', onEnd); process.once('SIGTERM', onEnd);

  async function limited<T>(params: unknown, run: () => Promise<T>): Promise<T> {
    if (closing) throw new McpError(ErrorCode.InternalError, 'The MCP bridge is closed.');
    if (Buffer.byteLength(JSON.stringify(params)) > MAX_PAYLOAD_BYTES) throw new McpError(ErrorCode.InvalidParams, 'Request is too large; it was not forwarded.');
    if (active >= MAX_ACTIVE_REQUESTS) throw new McpError(ErrorCode.InternalError, 'Too many active requests; this request was not forwarded.');
    active++;
    try {
      await remoteReady;
      if (closing) throw new Error('Closed');
      const result = await run();
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_PAYLOAD_BYTES) throw new Error('Oversized result');
      return result;
    } catch {
      // Do not include upstream error bodies, headers, URLs, or credentials.
      throw new McpError(ErrorCode.InternalError, FAILED_CONNECTION);
    } finally { active--; }
  }

  local.setRequestHandler(ListToolsRequestSchema, (request, extra) => limited(request.params ?? {}, () =>
    remote.listTools(request.params, { signal: extra.signal, timeout: REQUEST_TIMEOUT_MS, maxTotalTimeout: REQUEST_TIMEOUT_MS })));
  local.setRequestHandler(CallToolRequestSchema, (request, extra) => limited(request.params, () =>
    remote.callTool(request.params, CallToolResultSchema, { signal: extra.signal, timeout: REQUEST_TIMEOUT_MS, maxTotalTimeout: REQUEST_TIMEOUT_MS })));
  try {
    // Start stdin first so EOF cancels a connection attempt, including startup.
    // Tool handlers await remoteReady before issuing any remote request.
    remoteReady = remote.connect(http, { timeout: REQUEST_TIMEOUT_MS, maxTotalTimeout: REQUEST_TIMEOUT_MS });
    void remoteReady.catch(() => {});
    await local.connect(stdio);
    await remoteReady;
    if (!closing) ready = true;
    return handle;
  } catch {
    if (closing) {
      const exit = await closed;
      if (!exit.exitCode) return handle;
    }
    await close(1);
    throw new Error('Unable to connect to the private MCP server. Check its address and credential; no operation was retried.');
  }
}

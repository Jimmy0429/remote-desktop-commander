import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { DeviceRegistry } from './registry.js';
import { Relay } from './relay.js';
import { createMcpServer } from './mcp.js';
import { MAX_MESSAGE_BYTES, safeRemoteUrl } from './protocol.js';
import { dashboardHtml } from './dashboard.js';
import { acquireServerLock } from './server-lock.js';

export interface ControlServerOptions {
  dataDir: string; ownerToken: string; publicUrl?: string; host?: string; port?: number;
  callTimeoutMs?: number; waitMs?: number;
}
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const digest = (value: string) => createHash('sha256').update(value).digest();
const bearer = (req: IncomingMessage): string => {
  const value = req.headers.authorization;
  return typeof value === 'string' && /^Bearer [A-Za-z0-9_-]{32,256}$/.test(value) ? value.slice(7) : '';
};
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage, maximum = MAX_MESSAGE_BYTES): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Use application/json.');
  if (Number(req.headers['content-length']) > maximum) throw new HttpError(413, 'Request body too large.');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maximum) throw new HttpError(413, 'Request body too large.');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Expected a JSON object.');
  return value as Record<string, unknown>;
}

export async function createControlServer(options: ControlServerOptions): Promise<{ url: string; close(): Promise<void> }> {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.ownerToken)) throw new Error('Owner token must contain at least 32 random URL-safe characters. Run init to generate it.');
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const publicUrl = options.publicUrl ? safeRemoteUrl(options.publicUrl) : undefined;
  if (!isLoopback && publicUrl?.protocol !== 'https:') throw new Error('Non-loopback binding requires an HTTPS public URL and a TLS reverse proxy.');
  const dataDir = resolve(options.dataDir); mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const release = acquireServerLock(dataDir);
  let registry: DeviceRegistry;
  try {
    registry = DeviceRegistry.open(dataDir);
    // Calls cannot survive a server process. Persist uncertainty, never imply replay.
    for (const record of registry.recentAudit()) if (record.status === 'running') {
      const finishedAt = new Date().toISOString();
      registry.audit({ ...record, status: 'unknown', finishedAt, durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(record.startedAt)) });
    }
  }
  catch (e) { release(); throw e; }
  const ownerHash = digest(options.ownerToken);
  const relay = new Relay(registry, options.callTimeoutMs, options.waitMs);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  const rate = new Map<string, { count: number; until: number }>();
  const rejectedRate = new Map<string, { count: number; until: number }>();
  let url = ''; let active = 0; let closing = false;
  const html = dashboardHtml();
  const scriptHashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  const styleHashes = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  const csp = `default-src 'none'; script-src ${scriptHashes.join(' ') || "'none'"}; style-src ${styleHashes.join(' ') || "'none'"}; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

  function boundary(req: IncomingMessage): URL {
    if (closing) throw new HttpError(503, 'Server shutting down.');
    const expected = new URL(url);
    const allowedHosts = new Set([expected.host]);
    const localAliases = !publicUrl && isLoopback;
    if (localAliases) for (const h of ['127.0.0.1', 'localhost', '[::1]']) allowedHosts.add(`${h}${expected.port ? `:${expected.port}` : ''}`);
    const requestHost = req.headers.host?.toLowerCase();
    if (!requestHost || !allowedHosts.has(requestHost)) throw new HttpError(403, 'Unrecognized host.');
    const allowedOrigin = localAliases ? `${expected.protocol}//${requestHost}` : expected.origin;
    if (req.headers.origin && req.headers.origin !== allowedOrigin) throw new HttpError(403, 'Unrecognized browser origin.');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site requests are not allowed.');
    const requestUrl = new URL(req.url || '/', expected);
    if (requestUrl.search || requestUrl.hash) throw new HttpError(400, 'Query parameters are not accepted.');
    return requestUrl;
  }
  function limit(req: IncomingMessage, bucket: string, max: number, authenticated = false): void {
    const now = Date.now();
    const counters = authenticated ? rate : rejectedRate;
    for (const [key, value] of counters) if (value.until < now) counters.delete(key);
    const key = authenticated ? bucket : `${bucket}:${req.socket.remoteAddress}`;
    if (!counters.has(key) && counters.size >= 2048) throw new HttpError(429, 'Server is busy; try later.');
    const value = counters.get(key) || { count: 0, until: now + 60_000 };
    value.count++; counters.set(key, value);
    if (value.count > max) throw new HttpError(429, 'Too many requests; try later.');
  }
  function authorize(req: IncomingMessage): void {
    if (!timingSafeEqual(digest(bearer(req)), ownerHash)) {
      limit(req, 'invalid-owner', 120);
      throw new HttpError(401, 'Owner authorization required.');
    }
    limit(req, 'owner', 600, true);
  }
  const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 15_000, headersTimeout: 10_000 }, async (req, res) => {
    if (active >= 64) { json(res, 503, { error: 'Server is busy.' }); return; }
    active++;
    try {
      const path = boundary(req).pathname;
      if (path === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
        res.end(html); return;
      }
      if (path === '/health' && req.method === 'GET') { json(res, 200, { status: 'ok' }); return; }
      if (path === '/api/enroll' && req.method === 'POST') {
        const data = object(await body(req, 16 * 1024));
        if (typeof data.code !== 'string' || typeof data.name !== 'string' || typeof data.platform !== 'string') throw new HttpError(400, 'code, name and platform are required.');
        try { json(res, 200, registry.enroll(data.code, data.name, data.platform)); }
        catch {
          // A genuine one-use pairing must not share an attacker's proxy/IP budget.
          limit(req, 'invalid-enroll', 20);
          throw new HttpError(400, 'Enrollment failed: check the code, expiry, and device details.');
        }
        return;
      }
      authorize(req);
      if (path === '/api/devices' && req.method === 'GET') { json(res, 200, { devices: relay.devices() }); return; }
      if (path === '/api/activity' && req.method === 'GET') { json(res, 200, { activity: registry.recentAudit() }); return; }
      if (path === '/api/pairings' && req.method === 'POST') { object(await body(req)); json(res, 200, registry.createPairing()); return; }
      const revoke = /^\/api\/devices\/([a-zA-Z0-9-]{1,128})\/revoke$/.exec(path);
      if (revoke && req.method === 'POST') {
        object(await body(req));
        if (!registry.revoke(revoke[1])) throw new HttpError(404, 'Device not found.');
        relay.disconnect(revoke[1]); json(res, 200, { revoked: true }); return;
      }
      if (path === '/mcp') {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); json(res, 405, { error: 'Use MCP Streamable HTTP POST.' }); return; }
        const payload = await body(req);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        const mcp = createMcpServer(relay);
        res.on('close', () => { void transport.close().then(() => mcp.close()).catch(() => {}); });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, payload);
        return;
      }
      throw new HttpError(404, 'Not found.');
    } catch (e) {
      if (!res.headersSent && !res.destroyed) json(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'Request could not be completed.' });
      else if (!res.writableEnded) res.end();
    } finally { active--; }
  });
  // Keep the database lock strongly reachable even if a caller drops our handle.
  // Normal shutdown closes the relay and WebSockets before closing HTTP.
  server.once('close', release);
  server.maxConnections = 256;
  server.setTimeout(20_000, socket => socket.destroy());
  server.on('upgrade', (req, socket, head) => {
    // Upgrade sockets no longer have the HTTP server's error/lifecycle handling.
    socket.on('error', () => socket.destroy());
    try {
      if (boundary(req).pathname !== '/agent') throw new HttpError(404, 'Not found.');
      if (wss.clients.size >= 256) throw new HttpError(503, 'Too many connections.');
      const device = registry.authenticate(bearer(req));
      if (!device) { limit(req, 'invalid-agent', 60); throw new HttpError(401, 'Device authorization required.'); }
      limit(req, `device:${device.id}`, 60, true);
      wss.handleUpgrade(req, socket, head, ws => relay.attach(device.id, ws));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 400;
      const rejectionTimer = setTimeout(() => socket.destroy(), 1000);
      rejectionTimer.unref();
      socket.once('close', () => clearTimeout(rejectionTimer));
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
    }
  });
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); done(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No server address.');
    url = publicUrl?.origin ?? `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  } catch (e) { relay.close(); wss.close(); server.close(); release(); throw e; }
  return { url, close: async () => {
    if (closing) return;
    closing = true; relay.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(done => wss.close(() => done()));
    await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
    release();
  } };
}

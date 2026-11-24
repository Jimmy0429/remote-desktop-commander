// The USB bundle exposes the file-only pilot and an isolated loopback check.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentOptions, AgentHandle } from './agent.js';
import { startPortableAgent } from './portable-agent.js';
import { createControlServer } from './server.js';
import { VERSION } from '../version.js';

export { VERSION };
export { safeRemoteUrl } from './protocol.js';
export { publishEnrollment, parseCredential } from './enrollment.js';
export { ensurePrivateDirectory, readPrivateTextFile } from './private-storage.js';

export function startAgent(options: AgentOptions & { portablePilotFile: string }): Promise<AgentHandle> {
  if (!options.portablePilotFile) throw new Error('The USB agent requires its designated pilot file.');
  return startPortableAgent(options);
}

export async function runUsbCheck({workspace, stateDir}: {workspace: string; stateDir: string}) {
  const ownerToken = randomBytes(32).toString('base64url');
  const testedFile = join(workspace, 'pilot-check.txt');
  const server = await createControlServer({
    dataDir: join(stateDir, 'relay'), ownerToken, host: '127.0.0.1', port: 0, waitMs: 8000
  });
  const client = new Client({name: 'usb-loopback-check', version: VERSION});
  const signal = AbortSignal.timeout(45000);
  let agent: AgentHandle | undefined;
  try {
    const post = async (path: string, data: object, owner = false) => {
      const response = await fetch(server.url + path, {
        method: 'POST', body: JSON.stringify(data), redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', ...(owner ? {Authorization: 'Bearer ' + ownerToken} : {}) }
      });
      if (!response.ok) throw new Error('Local USB check could not pair its temporary agent.');
      return response.json();
    };
    const pairing = await post('/api/pairings', {}, true);
    const {deviceId, token} = await post('/api/enroll', {code: pairing.code, name: 'Local USB check', platform: process.platform});
    agent = await startAgent({serverUrl: server.url, deviceToken: token, workspace, stateDir, portablePilotFile: testedFile, signal});
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url + '/mcp'), {
      requestInit: {headers: {Authorization: 'Bearer ' + ownerToken}, redirect: 'error'}
    }));
    const request = async (name: string, args: Record<string, unknown>) =>
      CallToolResultSchema.parse(await client.callTool({name, arguments: args}, undefined, {signal}));
    // The socket may open one turn before the relay processes the ready message.
    for (;;) {
      const devices = (await request('list_devices', {})).structuredContent?.devices;
      if (Array.isArray(devices) && devices.some(d => d.id === deviceId && d.online)) break;
      await delay(50, undefined, {signal});
    }
    const marker = 'Jimmy Remote Commander USB check ' + randomBytes(12).toString('hex');
    async function fileCall(name: string, args: object) {
      let result = await request(name, {deviceId, ...args});
      const callId = result.structuredContent?.callId;
      if (typeof callId === 'string') {
        while (result.structuredContent?.status === 'running') {
          await delay(50, undefined, {signal});
          result = await request('get_remote_call', {callId});
        }
        if (result.structuredContent?.status !== 'completed') throw new Error('Local USB file check did not complete.');
        result = CallToolResultSchema.parse(result.structuredContent.result);
      }
      if (result.isError) throw new Error('Local USB file check was refused.');
      return result;
    }
    await fileCall('write_file', {path: testedFile, content: marker});
    const read = await fileCall('read_file', {path: testedFile});
    if (!JSON.stringify(read).includes(marker) || await readFile(testedFile, 'utf8') !== marker) {
      throw new Error('Local USB file check did not return the expected contents.');
    }
    return {version: VERSION, testedFile};
  } finally {
    try { await client.close(); }
    finally { try { await agent?.close(); } finally { await server.close(); } }
  }
}

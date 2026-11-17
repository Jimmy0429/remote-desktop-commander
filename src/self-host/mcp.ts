import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Relay } from './relay.js';

export function createMcpServer(relay: Relay): Server {
  const server = new Server({ name: 'jimmy-remote-commander', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'list_devices', description: 'List your enrolled computers and their current availability.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: 'get_remote_call', description: 'Get a retained remote call result. Poll this instead of resubmitting an operation that is still running or has an uncertain outcome.', inputSchema: { type: 'object', properties: { callId: { type: 'string' } }, required: ['callId'], additionalProperties: false }, annotations: { readOnlyHint: true } },
    ...relay.catalog(),
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = request.params.arguments || {};
    try {
      if (request.params.name === 'list_devices') {
        const devices = relay.devices();
        return { content: [{ type: 'text', text: JSON.stringify(devices, null, 2) }], structuredContent: { devices } };
      }
      if (request.params.name === 'get_remote_call') {
        if (typeof args.callId !== 'string' || args.callId.length > 128) throw new Error('A valid callId is required.');
        return relay.poll(args.callId);
      }
      return await relay.call(request.params.name, args);
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'The remote call failed.' }] };
    }
  });
  return server;
}

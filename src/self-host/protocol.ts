import { z } from 'zod/v4';
import { CallToolResultSchema, ToolSchema, type Tool, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const REMOTE_TOOL_NAMES = [
  'read_file','read_multiple_files','write_file','write_pdf','create_directory','list_directory',
  'move_file','get_file_info','edit_block','start_search','get_more_search_results','stop_search',
  'list_searches','start_process','interact_with_process','read_process_output','force_terminate',
  'list_sessions','list_processes','kill_process','get_config','get_usage_stats','get_recent_tool_calls',
] as const;
const allowedTools = new Set<string>(REMOTE_TOOL_NAMES);
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const toolName = z.string().min(1).max(128).refine(name => allowedTools.has(name), 'Tool not allowed');
const serverSchema = z.object({type:z.literal('call'),id,name:toolName,arguments:z.record(z.string(),z.unknown())}).strict();
const agentSchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('ready'),tools:z.array(ToolSchema).max(128)}).strict(),
  z.object({type:z.literal('result'),id,result:CallToolResultSchema}).strict(),
  z.object({type:z.literal('error'),id,message:z.string().min(1).max(2048)}).strict(),
]);
export type AgentMessage = {type:'ready';tools:Tool[]} | {type:'result';id:string;result:CallToolResult} | {type:'error';id:string;message:string};
export type ServerMessage = {type:'call';id:string;name:string;arguments:Record<string,unknown>};

function decode(value: unknown): unknown {
  const text = typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : JSON.stringify(value);
  if (!text || Buffer.byteLength(text,'utf8') > MAX_MESSAGE_BYTES) throw new Error('Invalid message size');
  return JSON.parse(text);
}
export function parseAgentMessage(value:unknown): AgentMessage { return agentSchema.parse(decode(value)) as AgentMessage; }
export function parseServerMessage(value:unknown): ServerMessage { return serverSchema.parse(decode(value)); }

/** Credentials are sent only to this exact user-selected origin, never a redirect. */
export function safeRemoteUrl(value:string): URL {
  const url = new URL(value);
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Server URL requires HTTPS (or loopback HTTP), with no credentials, path, query or fragment');
  }
  return url;
}

import {
  closeSync, fstatSync, ftruncateSync, lstatSync, openSync, readSync, realpathSync, writeSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { EngineCallError } from './device-engine.js';
import { ensurePrivateDirectory } from './private-storage.js';

const filename = 'pilot-check.txt';
const maxBytes = 64 * 1024;
const readArgs = new Set(['path', 'isUrl', 'offset', 'length']);
const writeArgs = new Set(['path', 'content', 'mode']);
const pilotPath = { type: 'string', description: 'Use pilot-check.txt in this session.' };
const tools: Tool[] = [
  { name: 'read_file', description: 'Read the USB pilot text file.',
    inputSchema: { type: 'object', required: ['path'], additionalProperties: false, properties: {
      path: pilotPath, isUrl: { const: false }, offset: { type: 'integer' }, length: { type: 'integer', minimum: 0 },
    } } },
  { name: 'write_file', description: 'Write up to 64 KiB of plain text to the USB pilot file.',
    inputSchema: { type: 'object', required: ['path', 'content'], additionalProperties: false, properties: {
      path: pilotPath, content: { type: 'string' }, mode: { enum: ['rewrite', 'append'] },
    } } },
];

function refused(message: string): EngineCallError {
  return new EngineCallError(message, 'not_started');
}

function plainText(text: string): boolean {
  // Permit newlines and tabs, including Windows CRLF. Reject binary/control data.
  return !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text);
}

/**
 * The portable agent owns one newly created file for its entire lifetime,
 * including WebSocket reconnects. Calls use its open descriptor. No path
 * supplied by the remote client is used to open a file or launch a process.
 */
export class PortableFileEngine {
  private fd?: number;
  private file?: string;
  private closed = false;

  constructor(private readonly workspace: string, private readonly requestedFile: string) {}

  async start(): Promise<Tool[]> {
    if (this.closed) throw refused('USB pilot is closed.');
    if (this.fd !== undefined) return tools;
    if (!isAbsolute(this.workspace) || this.requestedFile !== join(this.workspace, filename)) {
      throw refused('Choose a fresh private workspace for pilot-check.txt.');
    }
    ensurePrivateDirectory(this.workspace);
    this.file = join(realpathSync.native(this.workspace), filename);
    this.fd = openSync(this.file, 'wx+', 0o600);
    try {
      this.verifyFile();
    } catch (error) {
      await this.close();
      throw error;
    }
    return tools;
  }

  private verifyFile(): { fd: number; size: number } {
    if (this.fd === undefined || !this.file) throw refused('USB pilot is closed.');
    try {
      const held = fstatSync(this.fd, { bigint: true });
      const named = lstatSync(this.file, { bigint: true });
      if (realpathSync.native(this.requestedFile) === this.file &&
          named.isFile() && held.isFile() && held.nlink === 1n && named.nlink === 1n &&
          held.ino !== 0n && named.ino === held.ino && named.dev === held.dev && held.size <= BigInt(maxBytes)) {
        return { fd: this.fd, size: Number(held.size) };
      }
    } catch { /* A missing or renamed entry is a refusal. */ }
    throw refused('The USB pilot file changed identity, is linked, or exceeds 64 KiB. Choose a fresh session.');
  }

  async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (name !== 'read_file' && name !== 'write_file') throw refused('The USB pilot supports only read_file and write_file.');
    if (args.path !== filename && args.path !== this.requestedFile) throw refused('Choose only pilot-check.txt.');
    const allowed = name === 'read_file' ? readArgs : writeArgs;
    if (Object.keys(args).some(key => !allowed.has(key))) throw refused('Unsupported USB pilot file option.');
    const { fd, size } = this.verifyFile();
    if (name === 'read_file') {
      const { offset = 0, length } = args;
      if ((args.isUrl !== undefined && args.isUrl !== false) || typeof offset !== 'number' || !Number.isSafeInteger(offset) ||
          (length !== undefined && (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0))) {
        throw refused('The USB pilot reads only local text with optional line offset and length.');
      }
      const buffer = Buffer.alloc(size);
      let total = 0;
      while (total < size) {
        const count = readSync(fd, buffer, total, size - total, total);
        if (!count) break;
        total += count;
      }
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total)); }
      catch { throw refused('The USB pilot reads only UTF-8 text.'); }
      if (!plainText(text)) throw refused('The USB pilot reads only plain text.');
      if (offset !== 0 || length !== undefined) {
        const lines = text.split('\n');
        const start = offset < 0 ? Math.max(0, lines.length + offset) : offset;
        text = lines.slice(start, length === undefined ? undefined : start + length).join('\n');
      }
      return { content: [{ type: 'text', text }] };
    }

    const { content, mode = 'rewrite' } = args;
    if (typeof content !== 'string' || !plainText(content) || (mode !== 'rewrite' && mode !== 'append')) {
      throw refused('The USB pilot accepts plain text with rewrite or append mode.');
    }
    const start = mode === 'append' ? size : 0;
    if (start + Buffer.byteLength(content) > maxBytes) throw refused('The USB pilot file is limited to 64 KiB.');
    const bytes = Buffer.from(content);
    let total = 0;
    // Bounded synchronous I/O keeps read/append/rewrite operations ordered.
    while (total < bytes.length) {
      const count = writeSync(fd, bytes, total, bytes.length - total, start + total);
      if (!count) throw new Error('Incomplete USB pilot write.');
      total += count;
    }
    if (mode === 'rewrite') ftruncateSync(fd, bytes.length);
    return { content: [{ type: 'text', text: 'Saved pilot-check.txt.' }] };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
  }
}

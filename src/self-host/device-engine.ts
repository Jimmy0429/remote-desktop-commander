import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

/** The device transport uses only these operations; its caller selects the engine. */
export interface DeviceEngine {
  start(): Promise<Tool[]>;
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
  onDisconnect?(callback: () => void): void;
}

export class EngineCallError extends Error {
  constructor(message: string, public readonly execution: 'not_started' | 'completed') {
    super(message);
    this.name = 'EngineCallError';
  }
}

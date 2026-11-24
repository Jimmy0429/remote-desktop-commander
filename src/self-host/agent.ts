import { connectAgent, type AgentConnectionOptions, type AgentHandle } from './agent-connection.js';
import { LocalEngine, type EngineOptions } from './local-engine.js';
import { startPortableAgent } from './portable-agent.js';

export type { AgentHandle, AgentStatus, AgentExit } from './agent-connection.js';

export interface AgentOptions extends EngineOptions, AgentConnectionOptions {
  portablePilotFile?: string;
}

export function startAgent(options: AgentOptions): Promise<AgentHandle> {
  if (options.portablePilotFile !== undefined) {
    return startPortableAgent({ ...options, portablePilotFile: options.portablePilotFile });
  }
  return connectAgent(options, () => new LocalEngine(options));
}

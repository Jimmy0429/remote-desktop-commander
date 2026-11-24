import type { AgentOptions } from './agent.js';
import { connectAgent, type AgentHandle } from './agent-connection.js';
import { PortableFileEngine } from './portable-file.js';

/** Portable package entry point. Its dependency graph contains only the file pilot engine. */
export function startPortableAgent(options: AgentOptions & { portablePilotFile: string }): Promise<AgentHandle> {
  return connectAgent(options, () => new PortableFileEngine(options.workspace, options.portablePilotFile));
}

import path from 'path';
import os from 'os';

// Use user's home directory for configuration files
export const USER_HOME = os.homedir();
const configuredDirectory = process.env.JRC_CONFIG_DIR;
export const SELF_HOSTED_ENGINE = process.env.JRC_SELF_HOSTED === '1';
// LocalEngine resolves the chosen workspace before starting its child. Keep
// that launch-time value independent of configuration edits and reloads.
export const SELF_HOSTED_WORKSPACE = SELF_HOSTED_ENGINE ? process.env.JRC_WORKSPACE : undefined;
if (configuredDirectory !== undefined && !path.isAbsolute(configuredDirectory)) {
  throw new Error('JRC_CONFIG_DIR must be an absolute directory');
}
if (SELF_HOSTED_ENGINE && !configuredDirectory) {
  throw new Error('Self-hosted engine requires JRC_CONFIG_DIR');
}
export const CONFIG_DIR = configuredDirectory || path.join(USER_HOME, '.claude-server-commander');

// Paths relative to the config directory
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const TOOL_CALL_FILE = path.join(CONFIG_DIR, 'claude_tool_call.log');
export const TOOL_CALL_FILE_MAX_SIZE = 1024 * 1024 * 10; // 10 MB

export const DEFAULT_COMMAND_TIMEOUT = 1000; // milliseconds

// Longest one process call (start_process, interact_with_process,
// read_process_output) blocks, whatever timeout_ms asks for; the process keeps
// running and the caller reads the rest with read_process_output. It stays well
// under 60 s: that is the MCP SDK's default request timeout
// (DEFAULT_REQUEST_TIMEOUT_MSEC), which Claude Desktop and the remote device's
// own client use, and an answer capped at 60 s arrived just after the client had
// given up (-32001 "Request timed out", #447). The margin leaves time to build
// and deliver the answer.
export const MAX_PROCESS_WAIT_MS = 50000;

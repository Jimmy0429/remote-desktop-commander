import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { toolArgSchemas } from '../tools/schemas.js';
import { REMOTE_TOOL_NAMES } from './protocol.js';

type RemoteToolName = (typeof REMOTE_TOOL_NAMES)[number];
interface Metadata {
  title: string;
  description: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
}

const filePaths = 'Paths refer to the selected device. Absolute paths are recommended; file operations respect that device\'s configured allowed directories.';

// These descriptions and annotations belong to the control server. Device
// advertisements report capability names, never instructions for an AI client.
const metadata: Record<RemoteToolName, Metadata> = {
  read_file: {
    title: 'Read File or URL', readOnlyHint: true, destructiveHint: false, openWorldHint: true,
    description: 'Read a file on the selected device, or fetch a URL when isUrl is true. Text reads support zero-based offset and length; a negative offset reads from the end. Supported documents include PDF, Word and Excel; use sheet and range for spreadsheets. Large files can be read in bounded portions. ' + filePaths,
  },
  read_multiple_files: {
    title: 'Read Multiple Files', readOnlyHint: true, destructiveHint: false, openWorldHint: false,
    description: 'Read several files on the selected device in one call. Each path has its own result or error, so one unreadable file does not hide the others. ' + filePaths,
  },
  write_file: {
    title: 'Write File', readOnlyHint: false, destructiveHint: true, openWorldHint: false,
    description: 'Write or append file contents on the selected device. The default rewrite mode replaces existing contents; append adds to the file. Text uses string content. Excel accepts JSON arrays or a sheet-name mapping; new Word documents accept Markdown headings. Use write_pdf for PDF creation and edit_block for focused changes to existing files. ' + filePaths,
  },
  write_pdf: {
    title: 'Write/Modify PDF', readOnlyHint: false, destructiveHint: true, openWorldHint: false,
    description: 'Create a PDF from Markdown or modify a PDF using insert/delete page operations on the selected device. Page indexes are zero-based. An insert can contain Markdown or sourcePdfPath; delete uses pageIndexes. Supply a new outputPath for the result, keeping an existing source PDF intact. Rendering may require the device\'s browser dependency. ' + filePaths,
  },
  create_directory: {
    title: 'Create Directory', readOnlyHint: false, destructiveHint: false, openWorldHint: false,
    description: 'Create a directory on the selected device, including missing parent directories, or ensure that an existing directory is present. ' + filePaths,
  },
  list_directory: {
    title: 'List Directory Contents', readOnlyHint: true, destructiveHint: false, openWorldHint: false,
    description: 'List files and subdirectories on the selected device with a configurable depth, defaulting to two levels. Use start_search for targeted filename or content searches in large directory trees. ' + filePaths,
  },
  move_file: {
    title: 'Move/Rename File', readOnlyHint: false, destructiveHint: true, openWorldHint: false,
    description: 'Move or rename a file or directory on the selected device using source and destination paths. This changes its location; ensure the destination is the intended path before calling. ' + filePaths,
  },
  get_file_info: {
    title: 'Get File Information', readOnlyHint: true, destructiveHint: false, openWorldHint: false,
    description: 'Read metadata for a file or directory on the selected device, including type, size, timestamps and permissions. Text metadata can include lineCount, zero-based lastLine and appendPosition; spreadsheet metadata can include sheet names and dimensions. ' + filePaths,
  },
  edit_block: {
    title: 'Edit Block', readOnlyHint: false, destructiveHint: true, openWorldHint: false,
    description: 'Make a focused edit on the selected device. Text files use exact old_string/new_string replacement; include enough surrounding text to identify the intended occurrence. expected_replacements defaults to one. Excel range edits use a range such as Sheet1!A1:C3 and a two-dimensional content array. Existing Word documents use the XML returned by read_file for exact replacement. ' + filePaths,
  },
  start_search: {
    title: 'Start Search', readOnlyHint: true, destructiveHint: false, openWorldHint: false,
    description: 'Start a background search on the selected device and return a search session ID. searchType files matches names; content searches inside files. pattern is a regular expression unless literalSearch is true. filePattern filters file types; includeHidden, ignoreCase, contextLines and maxResults refine the search. Read subsequent pages with get_more_search_results and stop work with stop_search. ' + filePaths,
  },
  get_more_search_results: {
    title: 'Get Search Results', readOnlyHint: true, destructiveHint: false, openWorldHint: false,
    description: 'Read results and status for a search session created by start_search on the same selected device. offset is zero-based and length limits the page. A negative offset reads the last N results, ignoring length. Poll this session while it is running instead of starting the search again.',
  },
  stop_search: {
    title: 'Stop Search', readOnlyHint: false, destructiveHint: false, openWorldHint: false,
    description: 'Stop an active background search on the selected device using its sessionId. Already collected results remain available briefly through get_more_search_results until the device cleans up the session.',
  },
  list_searches: {
    title: 'List Active Searches', readOnlyHint: true, destructiveHint: false, openWorldHint: false,
    description: 'List tracked search sessions and their status on the selected device. Use the returned session IDs with get_more_search_results or stop_search on that same device.',
  },
  start_process: {
    title: 'Start Terminal Process', readOnlyHint: false, destructiveHint: true, openWorldHint: true,
    description: 'Run a shell command, script or REPL on the selected device. timeout_ms controls the initial wait for output; a running command returns a process session for read_process_output or interact_with_process. shell can select an installed shell. Commands run with the agent user\'s permissions and may change files or contact external systems; file-directory limits are not a terminal sandbox.',
  },
  interact_with_process: {
    title: 'Send Input to Process', readOnlyHint: false, destructiveHint: true, openWorldHint: true,
    description: 'Send input to an existing terminal or REPL session on the selected device using its pid. This can execute further commands. timeout_ms bounds the wait and wait_for_prompt controls prompt waiting. Read the output before sending additional input; use force_terminate to end the session.',
  },
  read_process_output: {
    title: 'Read Process Output', readOnlyHint: true, destructiveHint: false, openWorldHint: false,
    description: 'Read output and completion status from a terminal session on the selected device. Use its pid from start_process. timeout_ms controls waiting; offset and length select output lines, with negative offset reading the tail. Continue reading the existing session instead of starting its command again.',
  },
  force_terminate: {
    title: 'Force Terminate Process', readOnlyHint: false, destructiveHint: true, openWorldHint: false,
    description: 'Forcefully stop a terminal session on the selected device using its pid. The process may have unfinished writes or other work; termination does not undo effects that already occurred.',
  },
  list_sessions: {
    title: 'List Terminal Sessions', readOnlyHint: true, destructiveHint: false, openWorldHint: false,
    description: 'List terminal sessions tracked by the tool engine on the selected device, including their process identifiers and status. Use the same device with read_process_output, interact_with_process or force_terminate.',
  },
  list_processes: {
    title: 'List Running Processes', readOnlyHint: true, destructiveHint: false, openWorldHint: false,
    description: 'List operating-system processes on the selected device, with identifiers and available resource information. This includes processes beyond the terminal sessions created by this tool engine.',
  },
  kill_process: {
    title: 'Kill Process', readOnlyHint: false, destructiveHint: true, openWorldHint: false,
    description: 'Terminate an operating-system process on the selected device using a positive pid. This can affect programs outside this tool engine. Verify the process identity first; killing it can interrupt work and does not reverse effects that already occurred.',
  },
  get_config: {
    title: 'Get Configuration', readOnlyHint: true, destructiveHint: false, openWorldHint: false,
    description: 'Read the selected device tool engine\'s configuration, including allowed directories, blocked commands, default shell, line limits and environment information. This operation does not change policy. Remote configuration mutation is not exposed by this service.',
  },
  get_usage_stats: {
    title: 'Get Usage Statistics', readOnlyHint: true, destructiveHint: false, openWorldHint: false,
    description: 'Read local tool usage counters and performance statistics from the selected device\'s engine. These are device-local statistics, not billing or account information from an external service.',
  },
  get_recent_tool_calls: {
    title: 'Get Recent Tool Calls', readOnlyHint: true, destructiveHint: false, openWorldHint: false,
    description: 'Read recent local tool-call history on the selected device. maxResults bounds the returned records; toolName and since filter the history. The private self-host engine redacts call arguments and result bodies from persisted history.',
  },
};

const canonical: Tool[] = REMOTE_TOOL_NAMES.map(name => {
  const schema = toolArgSchemas[name];
  if (!schema) throw new Error(`No local argument schema for remote tool ${name}`);
  const inputSchema = zodToJsonSchema(schema) as Tool['inputSchema'];
  if (inputSchema.type !== 'object') throw new Error(`Remote tool ${name} must accept an object`);
  const { description, ...annotations } = metadata[name];
  return { name, description, inputSchema, annotations };
});

/** Stable offline catalog; callers receive independent copies for relay decoration. */
export function canonicalToolCatalog(): Tool[] {
  return structuredClone(canonical);
}

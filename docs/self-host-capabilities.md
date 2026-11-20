# Private-service capability comparison

Snapshot: November 17, 2026. Compare behavior, not only tool names. The installed original Remote Desktop Commander connector and this fork's source catalog were inspected. The hosted implementation is closed source, so this is not a security comparison of the two implementations.

| Capability | Private service | Original remote connector |
| --- | --- | --- |
| File/directory reading, metadata, creation, writing, moving | Available | Available |
| Focused text/Word/Excel editing | Available through original engine | Available |
| PDF creation/modification | Tool available; browser dependency and Windows rendering still need pilot verification | Available |
| Streaming file/content search and search sessions | Available | Available |
| Shell commands, interactive processes, output paging, session/process listing and termination | Available through original engine; broader PowerShell behavior remains a Windows pilot gate | Available |
| Configuration inspection, usage statistics, recent local tool history | Available; private history redacts arguments and results | Available |
| Multiple devices and explicit target selection | Available; device ID always required | Available |
| Long-running call result polling | `get_remote_call` | `get_tool_result` |
| Recent remote-call discovery | Dashboard activity exists; no MCP history-list tool yet | `list_remote_tool_calls` |
| Remote configuration mutation | Deliberately omitted; local administration only | `set_config_value` |
| AI tool to disconnect the device | Not implemented; owner can revoke access through CLI/dashboard | `shutdown` |
| Hosted identity/quota inspection | No hosted account/quota system | `who_am_i` |
| Vendor-specific review of blocked calls | Not applicable to private service; use AI client's own approval flow | `review_device_call` |
| Rich file-preview/configuration UI resources | Not proxied by the private tool relay | Present in the original local engine; hosted/client exposure varies |
| OAuth browser login | Not implemented; private bearer credential | Available in original hosted service |
| Desktop-client stdio connection | New bridge; see verification report for tested status | Local engine supports stdio; hosted service uses HTTP |
| Screen streaming, mouse clicks, keyboard desktop automation | Not supplied by this engine | Not in the inspected connector's tool catalog |

The private catalog preserves all 23 selected engine tools: `read_file`, `read_multiple_files`, `write_file`, `write_pdf`, `create_directory`, `list_directory`, `move_file`, `get_file_info`, `edit_block`, `start_search`, `get_more_search_results`, `stop_search`, `list_searches`, `start_process`, `interact_with_process`, `read_process_output`, `force_terminate`, `list_sessions`, `list_processes`, `kill_process`, `get_config`, `get_usage_stats`, and `get_recent_tool_calls`. `list_devices` and `get_remote_call` are provided by the control server.

Removing remote configuration changes preserves a useful policy boundary: an AI tool cannot simply broaden the configured file directories or remove command restrictions through the configuration API. This does not make the engine an OS sandbox: shell commands still run with the agent user's Windows privileges. Windows ACLs protect storage from other unprivileged accounts, not from that same user's processes or administrators.

Before calling this full parity, resolve or explicitly accept the missing remote-call discovery, disconnect, configuration workflow, UI-resource, and authentication behaviors. Do not invent equivalents for vendor billing or approval services that the private product does not have.

Sources: [original remote project](https://github.com/desktop-commander/remote-desktop-commander), [open-source engine](https://github.com/wonderwhy-er/DesktopCommanderMCP), local `src/self-host/protocol.ts`, `catalog.ts`, and `mcp.ts`, and the connected original connector catalog inspected on the snapshot date.

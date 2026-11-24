# Jimmy's Remote Desktop Commander — first version

Status: approved by the user on 2026-11-16: “Approve the design and build it.” Private service for their own computers; implementation is authorized.

## Intent

Give Jimmy an independently operated service that lets an MCP-compatible AI client manage files and terminal processes on his connected computers. Reuse the MIT DesktopCommanderMCP engine and preserve its license and attribution. Do not depend on Desktop Commander's proprietary hosted service.

## Approaches

1. Fork the open-source engine and put our own authenticated relay and agent around its stdio MCP interface. Recommended: retains the mature tools, isolates per-device process state, and avoids reproducing the proprietary service's internal protocol.
2. Adapt the existing vendor remote agent and reproduce its Supabase/MQTT backend contracts. More coupling to a backend whose implementation is unavailable; greater maintenance and migration effort.
3. Reimplement the file and terminal tools from scratch. Small initial dependency surface but loses the existing tested features and is outside the user's selected fork approach.

The user selected the open-source-fork direction in conversation. Approach 1's specific process boundary and implementation details are the builder's recommendation.

## First-release scope

- A single owner controls multiple explicitly enrolled Windows, macOS, or Linux computers.
- One Node.js control server exposes an authenticated Streamable HTTP MCP endpoint.
- A device agent connects outward to that server; it exposes no listening port on the computer.
- The agent starts this fork's local MCP tool engine as a supervised child process.
- A simple web dashboard shows enrolled devices, online status, pairing, revocation, and recent call status.
- CLI commands initialize a server, enroll/list/revoke devices, and start an agent.
- Local end-to-end verification includes a real file write/read and a harmless terminal command through the MCP endpoint.
- A documented self-host deployment configuration is supplied. Public hosting, domain choice, and connection to an actual AI app are separate deployment checks; local tests cannot prove those work.

## Authentication and credentials

For a first private release, use a high-entropy owner token and a distinct random token per device. Store only device-token hashes on the server. The owner token authenticates management and MCP requests; a device credential can only authenticate its own agent connection. Generate credentials locally and store agent credentials in an ignored file with restrictive permissions. Never print credentials in logs or place them in URLs. Never place credentials in the public fork.

Pairing is initiated by the owner, expires quickly, and can be consumed only once. Device enrollment requires explicit acceptance through the local agent command. Revocation closes active connections, rejects outstanding calls, and prevents reconnects. Revoked credentials cannot be restored by reusing an enrollment code.

The private first release supports MCP clients that can send an Authorization bearer header. OAuth browser login and public self-service accounts are a later scope unless the user selects them now. Do not describe ChatGPT/plugin sign-in as verified until tested against the actual client.

## Server and transport

Use TypeScript and the upstream MCP SDK. Keep new code under `src/self-host/`. Use Node's HTTP server and WebSocket transport for outbound agents. The control server runs one authenticated MCP transport per client session or request as appropriate for the SDK; device engines remain isolated child processes on their respective computers.

Bind to loopback by default. HTTPS/WSS is required for non-loopback deployment, provided by a TLS reverse proxy with a documented trusted boundary. Reject unexpected browser origins and host headers. Do not trust arbitrary forwarded headers. Limit message and request body sizes, pending calls, pairing attempts, and connection attempts.

Use durable local storage for enrollment, revocation, and call audit metadata; write atomically with private permissions. The first server is single-process and uses a single data directory. Concurrent processes sharing the same directory are unsupported and must fail clearly or be explicitly documented as prohibited. Container deployment mounts persistent storage.

## Device selection and tool routing

Expose device discovery and the available upstream tool catalog through MCP. Every forwarded operation has an explicit device selector. If only one device is online it may be selected automatically only when unambiguous; multiple-device selection errors must name the available choices. Never substitute another computer when the selected computer is offline.

Preserve upstream tool schemas, annotations, and results while adding a device selector at the relay boundary. Remove that selector before sending arguments to the local engine. Management operations that change agent policy or credentials are not exposed as ordinary AI tools. Filter vendor feedback/onboarding and UI-only tools that depend on unavailable resources. The policy and supported tool set are documented.

Correlate requests with cryptographically random IDs. Validate protocol messages before accepting them. A result must come from the same authenticated device connection that received its request. Heartbeats identify stale connections. Reconnecting cannot complete calls assigned to a previous connection.

## Call lifecycle

Calls have queued/running/completed/failed/unknown outcomes. A disconnected or timed-out write or command has an unknown execution outcome and must never be automatically retried. Long-running calls return a call ID after a bounded wait and can be polled for their result. Audit records contain time, device, tool name, duration, and outcome; omit file contents, command arguments, credentials, and result bodies from durable audit storage. Bound retained completed results in memory by size and time.

The agent reconnects with bounded exponential backoff. It advertises readiness only after the local engine initializes and lists tools. Engine failure marks the device unavailable until it is restarted and ready; in-flight calls receive explicit errors without replay. Closing the agent closes the WebSocket and MCP transport and reaps the child process.

## Fork isolation and privacy

Give this fork a dedicated configuration-directory override used by configuration, tool history, usage tracking, and logs. Do not repurpose HOME or change an existing Desktop Commander installation's settings. Disable vendor telemetry, vendor remote feature flags, vendor onboarding, and automatic browser downloading on the self-hosted path. PDF generation may request its normal runtime dependency when explicitly used; document that separately.

File-directory limits are not an operating-system sandbox. Terminal tools execute with the local agent user's permissions. The initial test agent is limited to the task's workspace for file tests, and terminal tests perform only harmless fixture operations.

## User experience

Working name: Jimmy Remote Commander, changeable later. A small dashboard provides a clear connection status, device list, add-device instructions, revoke controls, and recent operation outcomes. It does not show a live screen or offer mouse/keyboard GUI automation. Use original project styling rather than copying the vendor's proprietary brand assets.

## Validation and acceptance

1. Authentication rejects missing/invalid owner credentials, wrong device credentials, expired/reused pairing codes, and revoked devices.
2. Two devices remain isolated; calls and results cannot cross device IDs or connection generations.
3. Real MCP client initialization, tool listing, file write/read, and process execution traverse server → agent → upstream engine → server.
4. Offline, disconnect, timeout, malformed messages, oversized payloads, result polling, and restart behavior are tested.
5. Configuration/history/log paths remain inside the fork's explicit state directory; self-host startup makes no vendor telemetry or feature-flag requests and does not download Chrome.
6. The existing build and upstream suite are run; unrelated failures are reported separately with evidence.
7. A fresh reviewer checks authentication, credential handling, replay risk, process cleanup, and deployment documentation.
8. Record exact commands and outcomes. Claim a working local build only after the end-to-end test passes. Cross-platform and public-client support remain qualified by the environments actually tested.

## Builder decisions

The builder may choose module boundaries, error wording, dashboard layout, test utilities, exact storage format, timeouts, and packaging within these constraints. Native implementation with delegated independent components/review is acceptable. Any public deployment requires a concrete destination and configured credentials; do not invent a hosting account, purchase a domain, or silently deploy a remote-control service.

# Private Remote Commander Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans with bounded parallel component ownership and an independent whole-branch review. The user approved the design and implementation; do not request another planning approval.

**Goal:** Deliver a locally verified, independently hosted, single-owner remote MCP service with multiple paired devices.

**Architecture:** Node HTTP/Streamable HTTP MCP server plus outbound WebSocket agents. Each agent supervises a stdio instance of the fork's existing tool engine. Owner-managed enrollment, hashed device credentials, revocation, and bounded asynchronous call tracking surround that engine.

**Tech Stack:** TypeScript, Node >=22.12, upstream MCP SDK, ws, node:test, plain HTML/CSS/JS dashboard.

**Spec:** `docs/superpowers/specs/2026-11-16-self-hosted-remote-design.md`

## Global Constraints

- Single owner; several explicitly enrolled devices; no public signup or OAuth in this release.
- Preserve MIT attribution; no proprietary hosted-service dependency.
- Loopback default; HTTPS/WSS for non-loopback origins; no silent deployment.
- Credentials in private ignored files or authorization headers, never URLs or logs.
- Device IDs and connection generations bind requests/results; no automatic replay.
- Fork-specific configuration and logs; vendor telemetry/flags/onboarding and eager Chrome download disabled on the self-host path.
- Run real MCP file and command round trips, authentication/failure tests, upstream build/suite, and independent review.

## Review Focus

- Consumed/expired pairing and revoked devices cannot regain access (Task 1).
- Reconnect/duplicate/late results cannot satisfy or replay calls for a different connection (Task 3).
- Engine exit, server shutdown, or lost network must not leave ready-but-broken devices or orphan child processes (Task 2/3).
- An invalid browser origin/host or device bearer cannot use owner routes (Task 3).
- Oversized, slow, malformed, or never-finishing requests cannot grow server memory without bounds (Task 3).

## Interface Contract

All components use `src/self-host/protocol.ts`. Agent messages: `{type:'ready',tools:Tool[]}`, `{type:'result',id,result:CallToolResult}`, `{type:'error',id,message}`. Server messages: `{type:'call',id,name,arguments:Record<string,unknown>}`. WebSocket ping/pong supplies heartbeat; payload limit 4 MiB; tool names and messages are validated. Device connection uses `/agent` and Authorization bearer only; ID resolved from token.

Registry `DeviceRegistry.open(dataDir)` returns a synchronous atomic-file-backed registry. Methods: `createPairing(): {code,expiresAt}`; `enroll(code,name,platform): {deviceId,token}`; `authenticate(token): DeviceRecord|undefined`; `list(): PublicDevice[]`; `revoke(id): boolean`; `audit(record): void`; `recentAudit(): AuditRecord[]`. Records expose id/name/platform/createdAt/revokedAt; hashes never leave the registry. Owner token initialization/auth lives in server bootstrap. Pairings are in-memory, one-use, five-minute lifetime.

`LocalEngine` exposes `start(): Promise<Tool[]>`, `call(name,args): Promise<CallToolResult>`, `close(): Promise<void>`, and `onDisconnect(callback)`. Constructor `{stateDir,workspace}`. Agent exports `startAgent({serverUrl,deviceToken,stateDir,workspace}): Promise<{close():Promise<void>}>`; supports reconnect and engine recovery, bounded duplicate tracking, no replay.

`createControlServer({dataDir,ownerToken,publicUrl?,host?,port?,callTimeoutMs?,waitMs?})` resolves `{url,close()}`. Owner REST: GET `/api/devices`, POST `/api/pairings`, POST `/api/devices/:id/revoke`, GET `/api/activity`. Enrollment POST `/api/enroll` takes code/name/platform. MCP POST `/mcp`, stateless HTTP transport per request; GET/DELETE return 405. Tools: `list_devices`, `get_remote_call`, plus curated upstream tools with an explicit `deviceId`. Only tool names in agent catalog are routable. Dashboard `/` contains no credentials; uses a token entered by user, held only in memory.

## Task 1: Durable enrollment and credential separation

Files: `src/self-host/registry.ts`, `test/test-self-host-registry.js`.

- [x] Write and run failing behavioral tests for one-use pairing, expiration, hashing, reload, revocation, malformed state, and bounded/redacted audit.
- [x] Implement atomic private registry storage, validation, fixed-capacity pairings/devices/audit, and credential comparison.
- [x] Run tests and record results.

## Task 2: Isolated local engine and outbound agent

Files: `src/self-host/protocol.ts`, `src/self-host/local-engine.ts`, `src/self-host/agent.ts`; relevant upstream startup/config/log modules; `test/test-self-host-agent.js`, `test/test-self-host-isolation.js`.

- [x] Write and run failing tests for dedicated config/history paths, disabled startup network, and agent lifecycle/routing.
- [x] Implement shared protocol validation and wrapper around MCP SDK stdio child.
- [x] Implement outbound WebSocket authentication, readiness, backoff, duplicate handling, bounded concurrency, cleanup, and local child recovery.
- [x] Verify using real upstream engine fixture operations and simulated disconnects.

## Task 3: Server, relay, and MCP gateway

Files: `src/self-host/server.ts`, `src/self-host/relay.ts`, `src/self-host/mcp.ts`, `test/test-self-host-server.js`.

- [x] Write and run failing tests for unauthenticated REST/MCP, wrong host/origin, device-owner separation, oversized input, and actual MCP list/call responses.
- [x] Implement authenticated HTTP and WebSocket paths, strict validation, heartbeat, private state locking, and rate/body/concurrency limits.
- [x] Implement per-connection relay with timeout/unknown semantics, capped/expiring results and redacted audit.
- [x] Expose device discovery and curated upstream tool schemas through MCP; return call IDs for work exceeding bounded wait.
- [x] Test two-device isolation, stale results, disconnect/revoke/timeout, result polling, and a real file/process round trip.

## Task 4: CLI, dashboard, and deployable package

Files: `src/self-host/cli.ts`, `src/self-host/dashboard.ts`, `docs/self-hosted.md`, `deploy/self-host/*`, package scripts, root README introduction, `.gitignore`.

- [x] Add init/serve/pair/enroll/agent/devices/revoke CLI commands; secrets read from private files or hidden input and never process arguments.
- [x] Add dashboard login in memory, device status, pairing instructions, revocation and activity; verify functionality in browser.
- [x] Add Docker/reverse-proxy deployment examples, persistent-volume and TLS instructions, client bearer-header configuration, and honest OAuth/platform limitations.
- [x] Mark the fork private for npm publishing and use fork branding in the new entrypoint while retaining upstream attribution.

## Task 5: Validation, independent review, and delivery

- [x] Build; run all new tests and upstream `npm test`; capture reports and investigate failures.
- [x] Conduct independent code review of auth, replay, bounds, lifecycle, and docs; fix actionable findings with regression tests.
- [x] Run a local real-engine demo and inspect dashboard; stop test agents after verification.
- [x] Commit/push implementation to the user's fork branch; record exact tested state and remaining deployment checks.

## Execution Ledger

- Fork: `Jimmy0429/remote-desktop-commander`; upstream baseline `bce370e9395f5bc74eda34913e5ae1dee48df8f8`.
- Existing checkout is isolated on `feat/self-hosted-remote`, initially clean; no extra worktree needed.
- User approved detailed design and build. Ruling: execute the approved plan without another planning confirmation, per user's direct implementation authorization.
- Parallel ownership: registry agent owns Task 1; engine agent owns Task 2; root owns Tasks 3/4 and integration. Interfaces above are binding; integration changes are coordinated.

- Tasks 1–4 complete. Full self-host suite: 34/34 passing; real file/search/process and document round trips verified. Browser verification passed and temporary server/agent stopped.
- Compatibility run: 272/274 files passed, 22 skipped checks. Both failures independently reproduced in unchanged upstream path-with-spaces code; see docs/self-host-verification.md.
- Independent review fixes: separate rejected/authenticated rate limits, startup unknown-state reconciliation, explicit bundled ripgrep installation, secret-free Docker build context. Regression tests passed; focused re-review cleared findings.
- Ruling: retain the two demonstrated upstream telemetry/install failures as documented limitations rather than widening this fork implementation to unrelated legacy fixes.

- Implementation pushed as `af74356e`; draft PR #1 opened in the user fork. Initial Node 22 CI passed macOS and exposed test-readiness and Windows command-quoting assumptions. Follow-up validation uses bounded readiness polling and Windows PowerShell; Docker runtime verification added on Linux.

- User requested collaboration with installed Anthropic Fable 5.2. Verified `claude-fable-5-2`; three substantive review/discussion rounds produced reproduced lifecycle, socket, catalog, targeting, and output-limit fixes. Decision record: docs/self-host-review-decisions.md.
- Final reviewed source `66388a0d`: 66 local tests pass; CI: Linux/macOS 66 passed, Windows 64 passed with 2 platform-specific skips; Docker named-volume initialization, competing-writer exclusion and SIGKILL recovery pass. Full upstream rerun after dependency upgrade: 275/277, with the same 2 baseline failures; subsequent isolated startup/transport checks: 2/2.
- Delivery remains draft PR #1 in the user fork; public hosting, real-computer enrollment/client connection and inherited dependency follow-up are clearly outside the verified build.

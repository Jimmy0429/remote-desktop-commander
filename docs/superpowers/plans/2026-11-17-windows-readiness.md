# Windows Readiness Implementation Plan

> **For agentic workers:** Use the established approved implementation workflow with independent review. Steps use checkbox syntax for tracking.

**Goal:** Leave a tested Windows-oriented checkpoint ready for tomorrow's computer installation.

**Architecture:** Preserve the private control server and outbound device agent. Add actual Windows private storage and a local stdio bridge without widening remote policy privileges.

**Tech Stack:** TypeScript, Node >=22.13.0, MCP SDK, PowerShell/.NET ACL APIs, GitHub Actions Windows/Linux/macOS.

**Spec:** ../specs/2026-11-17-windows-readiness-design.md

## Global constraints

- No installation on existing Avtec devices; user will provide a different Windows computer tomorrow.
- No public deployment, hosting purchase, machine startup task, or persistent AI client configuration tonight. Disposable client fixtures may verify the bridge.
- No secret values in arguments, stdout diagnostics, committed files, or review snapshots.
- Keep explicit device IDs, exact trusted origin, HTTPS except loopback, and no uncertain-operation replay.
- Do not remove original file/terminal capabilities to make tests pass.

## Review focus

- Broad inherited Windows ACLs must not silently expose owner/device tokens.
- Existing shared workspace directories must not have their ACLs silently rewritten.
- Redirect or dropped tool responses must not leak bearer credentials or execute a command twice.
- Stdio shutdown must close HTTP resources without corrupting MCP stdout.
- Windows paths with spaces/Unicode and state replacement must retain correct behavior and protection.

### Task 1: Private storage

Files: new `src/self-host/private-storage.ts`; integration in `cli.ts`, `registry.ts`, `local-engine.ts`, `server-lock.ts`; native tests under `test/test-self-host-*.js`.

Interfaces: synchronous `ensurePrivateDirectory`, `assertPrivateFile`, `writePrivateFile`, explicit `protectPrivateDirectory` helpers, finalized by implementation.

- [x] Add meaningful denial/protection tests, run to establish missing behavior.
- [x] Implement SID-based protected storage and integrate before secret/state use.
- [x] Verify local portability and actual Windows DACL outcomes in CI.

### Task 2: Desktop MCP bridge

Files: new `src/self-host/bridge.ts`; CLI command; tests under `test/test-self-host-*.js`.

Interface: `startStdioBridge({serverUrl, ownerToken})` returns close/closed handles. CLI validates private credential and forwards no secret argument to subprocesses.

- [x] Add actual SDK client/relay/agent tests and negative redirect/auth tests.
- [x] Implement bounded stdio forwarding with origin pinning, no replay, redacted errors and lifecycle cleanup.
- [x] Integrate CLI and document credential-file-based client configuration.

### Task 3: Compatibility and dependency review

- [x] Save current audit with runtime/development reachability distinctions.
- [x] Patch only compatible targeted markdown-it/node-forge releases and verify their owning functionality.
- [x] Reproduce and minimally fix inherited path-with-spaces failures without enabling self-host telemetry.

### Task 4: Checkpoint and handoff

- [x] Build, run integrated self-host/appropriate upstream checks, inspect complete results and resolve regressions.
- [x] Refresh source-only Fable review, challenge findings against actual code, and record decisions.
- [x] Push verified source to the existing feature branch and await Windows/Linux/macOS/container CI.
- [x] Write next-day handoff with exact branch/commit, test evidence, capability gaps, launch instructions and remaining decisions.

## Completed checkpoint

Verified source `49c70fd6725d9a8c3d056312576fdf2a55911839`; native run `44042873133` passed on Windows, Linux, macOS, and Docker. See `../../self-host-verification.md` for exact counts, local/Fable evidence, remaining dependency findings, and deferred real-PC deployment. No target Windows installation, permanent host, or autostart was configured.

# Private remote service verification

Verified locally on 2026-11-17 on macOS with Node 26.7.0 and npm 11.19.0. Upstream baseline: `bce370e9395f5bc74eda34913e5ae1dee48df8f8`.

## Working behavior

- `npm run build`: passed.
- `npm run test:self-host`: **66 tests passed**, including actual HTTP, WebSocket, and MCP transports.
- End-to-end: CLI pairing/enrollment → outbound agent → forked stdio engine → remote file write/read, search and terminal output → result polling → revocation.
- Document handlers: actual Excel and DOCX write/read and PDF read work with on-demand package loading.
- Boundaries: owner/device credentials are distinct; expired/consumed enrollment and revoked tokens fail; wrong-device and stale-connection results are ignored; timeouts/disconnects are marked unknown without replay; malformed/oversized input is rejected.
- Lifecycle: engine shutdown reaps a terminal descendant; rejected revoked credentials stop reconnect attempts; interrupted persisted calls become unknown on server restart.
- Privacy: dedicated config/history/log paths; no call payloads in persistent self-host audit/history; actual startup network interception observed zero vendor requests.
- Browser: owner sign-in, online/offline status, activity, pairing generation/hiding, revocation confirmation/status, and sign-out were exercised against a temporary local server. The test server and agent were stopped afterward.
- The bundled `@vscode/ripgrep` executable was installed explicitly and used for remote search.
- An independent review identified rate-limit isolation, restart-status, search installation, and Docker-context issues. Regression tests reproduced the behavior before correction. Focused re-review found those issues addressed.

## Cross-platform and container CI

[GitHub Actions run 44029695630](https://github.com/Jimmy0429/remote-desktop-commander/actions/runs/44029695630) passed on source commit `66388a0d85b8dd78d131766f84f88cfb830e759b`:

| Environment | Observed result |
| --- | --- |
| Linux, Node 22.23.4 | 66 passed, 0 failed |
| macOS, Node 22.23.5 | 66 passed, 0 failed |
| Windows, Node 22.23.4 | 64 passed, 0 failed, 2 platform-specific skips |
| Linux Docker, Node 22 image | Build, non-root initialization, authentication/Host checks, persistent enrollment, graceful restart, competing-server rejection, and SIGKILL recovery on a local named volume passed |

Windows skipped the registry file-symlink case and the paused-process OS-lock case. Its normal competing-process and crash-recovery tests did run. Codespell also passed. The final local integrated build and 66 tests passed on macOS/Node 26.7.0. Later documentation-only commits do not change this tested source.

## Upstream compatibility suite

`npm test` completed after the protocol-dependency patch (`16b1201e`): **275 of 277 test files passed**, with 22 platform/environment-specific skipped checks. Two failures are present in unchanged upstream code when the checkout path contains spaces:

1. `test-error-sanitization.js`: fallback path-redaction regular expressions leave a middle word from an unquoted path containing spaces. The owning sanitizer/helpers are byte-identical to the baseline and the exact baseline function reproduces the failure independently.
2. `test-track-installation.js`: the direct-entry guard compares encoded `import.meta.url` to an unencoded filesystem path, so installation tracking does not start from such a path. The entire owning script is unchanged from baseline. The exact guard was reproduced with a harmless no-op entrypoint and no telemetry requests.

These failures were not hidden or removed from the suite. They concern legacy telemetry/install paths; the new self-host path disables vendor telemetry and the documented installation skips the upstream project lifecycle script. The full compatibility suite is therefore **not entirely green**. This broad run preceded the later self-host review fixes. After those fixes, the expanded 66-test self-host suite passed, and the upstream startup/import and remote-transport checks passed 2/2 through the isolated-home runner with no skipped checks.

## Review with Fable 5.2

At the user's request, the installed Claude Code session was explicitly run with Fable; returned metadata confirmed `claude-fable-5-2`. A source-only snapshot excluded credentials and private runtime state. Findings were checked against the code and reproduced with tests before implementation. In its final focused read-only review, Fable identified no delivery-blocking defect in the lock, bounded transport, or relay. Its remaining lock-reference observation was already covered by the HTTP server close listener; source verification corrected that observation. See [review decisions](self-host-review-decisions.md).

The resulting 66-test suite covers crash-released SQLite locking, competing/paused writers, legacy-binary exclusion, rejected upgrade cleanup, local Origin aliases, agent startup retries and replacement, a stable offline catalog with server-owned metadata, explicit device selection, classified execution errors, duplicate refusal without losing the original result, and a 5 MiB read that preserves the engine and an existing terminal worker.

## Dependency review

The network validation path now uses Zod 4.6.7, and the MCP HTTP adapter uses `@hono/node-server` 2.1.8. All 29 legacy tool schemas still convert to JSON Schema through the package's explicit `zod/v3` compatibility API. Build, document checks, and actual MCP/agent tests passed after this change.

The post-update runtime dependency audit still reports **13 affected packages: 7 high and 6 moderate**. Its remaining Zod finding is the nested 3.x copy used by Chromium BiDi. The legacy `zod/v3` compatibility API also still accumulates validation errors for oversized invalid collections; upgrading the package does not harden that API. Other findings concern inherited preview, document/browser, or legacy enrollment dependencies. This is not a clean-audit release, and these paths need further review before public deployment. Audit snapshots are retained locally under `.self-host/verification/`.

## Remaining verification boundaries

- Docker is not installed on the development Mac. Container checks ran on Linux CI; public DNS, Caddy certificate issuance, and an external client remain untested.
- No public remote-control service was deployed and no real external computers were enrolled by this build task.
- A real AI app connection still needs verification after choosing a host. This release supports a bearer header, not OAuth browser sign-in.
- The file workspace is not an OS sandbox; terminal commands run with the agent user's permissions.

Local raw logs, baseline reproductions, temporary credentials, and the dashboard screenshot are retained under ignored `.self-host/` paths and are not published with the source.

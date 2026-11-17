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

## Upstream compatibility suite

`npm test` completed after the protocol-dependency patch (`16b1201e`): **275 of 277 test files passed**, with 22 platform/environment-specific skipped checks. Two failures are present in unchanged upstream code when the checkout path contains spaces:

1. `test-error-sanitization.js`: fallback path-redaction regular expressions leave a middle word from an unquoted path containing spaces. The owning sanitizer/helpers are byte-identical to the baseline and the exact baseline function reproduces the failure independently.
2. `test-track-installation.js`: the direct-entry guard compares encoded `import.meta.url` to an unencoded filesystem path, so installation tracking does not start from such a path. The entire owning script is unchanged from baseline. The exact guard was reproduced with a harmless no-op entrypoint and no telemetry requests.

These failures were not hidden or removed from the suite. They concern legacy telemetry/install paths; the new self-host path disables vendor telemetry and the documented installation skips the upstream project lifecycle script. The full compatibility suite is therefore **not entirely green**.

## Review with Fable 5.2

At the user's request, the installed Claude Code session was explicitly run with Fable; returned metadata confirmed `claude-fable-5-2`. A source-only snapshot excluded credentials and private runtime state. Findings were checked against the code and reproduced with tests before implementation. See [review decisions](self-host-review-decisions.md).

The resulting 66-test suite covers crash-released SQLite locking, competing/paused writers, legacy-binary exclusion, rejected upgrade cleanup, local Origin aliases, agent startup retries and replacement, a stable offline catalog with server-owned metadata, explicit device selection, classified execution errors, duplicate refusal without losing the original result, and a 5 MiB read that preserves the engine and an existing terminal worker.

## Dependency review

The network validation path now uses Zod 4.6.7, and the MCP HTTP adapter uses `@hono/node-server` 2.1.8. All 29 legacy tool schemas still convert to JSON Schema through the package's explicit `zod/v3` compatibility API. Build, document checks, and actual MCP/agent tests passed after this change.

The post-update runtime dependency audit still reports **13 affected packages: 7 high and 6 moderate**. Its remaining Zod finding is the nested 3.x copy used by Chromium BiDi. The legacy `zod/v3` compatibility API also still accumulates validation errors for oversized invalid collections; upgrading the package does not harden that API. Other findings concern inherited preview, document/browser, or legacy enrollment dependencies. This is not a clean-audit release, and these paths need further review before public deployment. Audit snapshots are retained locally under `.self-host/verification/`.

## Remaining verification boundaries

- The earlier 34-test Node 22 Linux/macOS/Windows matrix and Docker initialization/restart check passed on `16b1201e`. The expanded review suite and Docker crash/live-competitor checks require the next CI run; local tests do not establish those platform results.
- Docker is not installed on the development Mac. The image build and persistent-volume initialization/restart passed in Linux CI. Public DNS, Caddy certificate issuance, and an external client remain untested.
- No public remote-control service was deployed and no real external computers were enrolled by this build task.
- A real AI app connection still needs verification after choosing a host. This release supports a bearer header, not OAuth browser sign-in.
- The file workspace is not an OS sandbox; terminal commands run with the agent user's permissions.

Local raw logs, baseline reproductions, temporary credentials, and the dashboard screenshot are retained under ignored `.self-host/` paths and are not published with the source.

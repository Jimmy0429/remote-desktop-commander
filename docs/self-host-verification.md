# Private remote service verification

Verified locally on 2026-11-17 on macOS with Node 26.7.0 and npm 11.19.0. Upstream baseline: `bce370e9395f5bc74eda34913e5ae1dee48df8f8`.

## Working behavior

- `npm run build`: passed.
- `npm run test:self-host`: **34 tests passed**, including actual HTTP, WebSocket, and MCP transports.
- End-to-end: CLI pairing/enrollment → outbound agent → forked stdio engine → remote file write/read, search and terminal output → result polling → revocation.
- Document handlers: actual Excel and DOCX write/read and PDF read work with on-demand package loading.
- Boundaries: owner/device credentials are distinct; expired/consumed enrollment and revoked tokens fail; wrong-device and stale-connection results are ignored; timeouts/disconnects are marked unknown without replay; malformed/oversized input is rejected.
- Lifecycle: engine shutdown reaps a terminal descendant; rejected revoked credentials stop reconnect attempts; interrupted persisted calls become unknown on server restart.
- Privacy: dedicated config/history/log paths; no call payloads in persistent self-host audit/history; actual startup network interception observed zero vendor requests.
- Browser: owner sign-in, online/offline status, activity, pairing generation/hiding, revocation confirmation/status, and sign-out were exercised against a temporary local server. The test server and agent were stopped afterward.
- The bundled `@vscode/ripgrep` executable was installed explicitly and used for remote search.
- An independent review identified rate-limit isolation, restart-status, search installation, and Docker-context issues. Regression tests reproduced the behavior before correction. Focused re-review found those issues addressed.

## Upstream compatibility suite

`npm test` completed: **272 of 274 test files passed**, with 22 platform/environment-specific skipped checks. Two failures are present in unchanged upstream code when the checkout path contains spaces:

1. `test-error-sanitization.js`: fallback path-redaction regular expressions leave a middle word from an unquoted path containing spaces. The owning sanitizer/helpers are byte-identical to the baseline and the exact baseline function reproduces the failure independently.
2. `test-track-installation.js`: the direct-entry guard compares encoded `import.meta.url` to an unencoded filesystem path, so installation tracking does not start from such a path. The entire owning script is unchanged from baseline. The exact guard was reproduced with a harmless no-op entrypoint and no telemetry requests.

These failures were not hidden or removed from the suite. They concern legacy telemetry/install paths; the new self-host path disables vendor telemetry and the documented installation skips the upstream project lifecycle script. The full compatibility suite is therefore **not entirely green**.

## Dependency review

The network validation path now uses Zod 4.6.7, and the MCP HTTP adapter uses `@hono/node-server` 2.1.8. All 29 legacy tool schemas still convert to JSON Schema through the package's explicit `zod/v3` compatibility API. Build, document checks, and actual MCP/agent tests passed after this change.

The post-update runtime dependency audit still reports **13 affected packages: 7 high and 6 moderate**. Its remaining Zod finding is the nested 3.x copy used by Chromium BiDi. The legacy `zod/v3` compatibility API also still accumulates validation errors for oversized invalid collections; upgrading the package does not harden that API. Other findings concern inherited preview, document/browser, or legacy enrollment dependencies. This is not a clean-audit release, and these paths need further review before public deployment. Audit snapshots are retained locally under `.self-host/verification/`.

## Remaining verification boundaries

- A three-platform Node 22 GitHub Actions workflow is supplied. Its actual run results are recorded separately; local macOS tests alone do not establish Windows/Linux support.
- Docker is not installed on the development Mac. Docker build, persistent-volume initialization, public DNS, and TLS certificate issuance have not been exercised locally.
- No public remote-control service was deployed and no real external computers were enrolled by this build task.
- A real AI app connection still needs verification after choosing a host. This release supports a bearer header, not OAuth browser sign-in.
- The file workspace is not an OS sandbox; terminal commands run with the agent user's permissions.

Local raw logs, baseline reproductions, temporary credentials, and the dashboard screenshot are retained under ignored `.self-host/` paths and are not published with the source.

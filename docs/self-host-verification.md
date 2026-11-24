# Private remote service verification

## Pre-install verification

For the Windows pilot use **0.3.4** from the verified feature-branch commit. The packaged-client tests submit simultaneous edits against a real paired agent and compare the resulting file contents, then check that a PDF page edit requires a fresh destination and leaves its source intact. The relay tests finish a long call after 200 more recent requests and poll its original call ID. Recovery tests reopen the on-disk registry and verify outcomes for calls that were running when the server stopped.

The private plugin and desktop extension use the fork's stdio bridge. The qualification suite opens the packed desktop extension from a clean directory and reads a uniquely marked file from its enrolled agent. It also exercises the cached plugin configuration against a disposable server. Workspace tests cover case-sensitive paths, live policy changes and engine restarts. Enrollment tests cover an existing credential, a competing enrollment, an interrupted reply and identity-checked startup. Check the latest [draft PR checks](https://github.com/Jimmy0429/remote-desktop-commander/pull/1/checks) for the tested commit and platform results. The physical Windows pilot and off-host HTTPS connection remain separate acceptance steps.

## Previous November 17 Windows checkpoint

Verified source checkpoint: `49c70fd6725d9a8c3d056312576fdf2a55911839` on `feat/self-hosted-remote`. [Native CI run 44042873133](https://github.com/Jimmy0429/remote-desktop-commander/actions/runs/44042873133) passed for this source. Later handoff-only commits do not change the tested application or tests. This is ready for a private Windows pilot; it is not installed on the owner's computer or qualified for public deployment.

| Environment | Observed result |
| --- | --- |
| Windows, Node 22 | **81 passed, 0 failed, 2 platform-specific skips** (83 total) |
| Linux, Node 22 | **73 passed, 0 failed, 10 Windows-only skips** (83 total) |
| macOS, Node 22 | **73 passed, 0 failed, 10 Windows-only skips** (83 total) |
| Linux Docker, Node 22 image | Build, non-root initialization, authorization/Host checks, persistent enrollment, normal restart, competing-server exclusion, and crash recovery passed |

Codespell passed. Windows ran the real SDK → CLI bridge → relay → agent → engine round trip, dropped-response/no-replay test, detached pipe/EOF launch, native ACL/ownership/ancestor checks, SDK-filtered environment, disabled module cache, and a deliberately missing-module refusal. The two Windows skips remain the registry file-symlink fixture and paused-process lock case; normal competing-process and crash-recovery checks passed. Sanitized Windows receipt: ignored `.self-host/verification/windows-final-44042873133.json`.

### Changes and local evidence

- New Windows storage uses actual SID-based DACL and ownership checks, validates ancestors and reparse paths, protects newly created directories before writing secrets, and refuses unsafe existing storage. An explicit repair command is confined to dedicated app state. Windows defaults use LocalAppData.
- The Windows permission helper explicitly loads its three required inbox modules and disables automatic module discovery. Native probes isolated a real startup stall under the MCP SDK's filtered environment; the fix does not depend on a preloaded module cache or relax the helper's timeout or permission checks. The permanent regression also checks disabled caching and a missing-module failure.
- New desktop stdio bridge exposes the private service's tools through a local process. It keeps credentials in checked private files, pins the server endpoint, refuses redirects, bounds traffic, and never replays uncertain tool calls.
- The installed Claude Code client running **Fable 5.2** completed an actual disposable bridge → server → agent → engine round trip on the development Mac: exactly one write and one read, with credential-leak checks passing. No persistent client configuration was changed. Receipt: ignored `.self-host/verification/real-ai-client-receipt.json`.
- Local build and expanded self-host suite passed: **73 passed, 0 failed, 10 Windows-only skips** (83 checks total) on macOS/Node 26.7.0. The subsequent bridge-test completion correction passed its focused suite (**3 passed, 1 Windows-only skip**) before the final native qualification above. Production code was unchanged by that test correction. Logs: ignored `.self-host/verification/windows-module-import-build.log`, `windows-module-import-self-host.log`, and `bridge-async-completion-local.log`.
- The broader compatibility runner passed **283/283 test files**, reporting 22 platform/environment skips, after the dependency and path fixes. Later Windows-specific corrections were rechecked with the expanded self-host suite and native CI. Receipts are under ignored `.self-host/verification/windows-checkpoint-upstream/`.
- The two earlier path-with-spaces failures are fixed: runtime working-directory redaction preserves no known path fragment, and installer direct-entry detection uses a correctly encoded file URL. Installer telemetry now also honors private mode and environment opt-out before reading identity or inspecting processes.

### Dependency audit and pilot limits

The compatible updates to **markdown-it 14.3.3** and **node-forge 1.4.3** passed 11 owning test files. The audit now reports **11 production findings (5 high, 6 moderate)**, down from 13. Including development dependencies it reports **40 findings**, including **one development-only critical** in the inherited `nexe` download/decompression chain. This is not a clean-audit release.

The remaining runtime findings concern inherited router/document/browser and validation dependencies; the audit review distinguishes those paths from the private relay's authenticated HTTP path. Do not force incompatible major versions solely to suppress audit counts. Inherited URL-reading/document-fetch paths also need bounded download/body-timeout review before treating untrusted URLs as safe inputs.

The owner's actual Windows PC, a persistent desktop-app configuration, remote TLS/DNS/VPN deployment, and automatic startup remain unverified. The owner explicitly chose to perform installation tomorrow on a different computer; neither known Avtec device was changed. The container recommendation is an always-on Linux host/VM, not an already deployed or purchased service. See [handoff](../CONTINUE-TOMORROW.md) and [capability comparison](self-host-capabilities.md).

## Initial implementation evidence (historical)

The sections below record the earlier source checkpoint. Their 66-test counts, 13-package audit, and absence of a real client connection describe that earlier state; the Windows checkpoint above supersedes those figures.

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

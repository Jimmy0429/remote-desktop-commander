# Jimmy Remote Commander

Run a private control service for your own computers. An MCP client sends file and terminal operations to your server, and the enrolled computer executes them through this fork's DesktopCommanderMCP engine. The dashboard manages devices and shows recent operation outcomes.

This release supports one owner and multiple devices. It provides file, search, code-editing, and terminal tools. It does not stream a screen or provide mouse and keyboard automation.

## How the parts connect

```text
MCP client ── HTTPS + owner bearer token ──> Control server
                                               ▲
                                               │ outbound WSS + device token
                                               │
                                         Device agent
                                               │ local stdio
                                               ▼
                                      DesktopCommanderMCP
```

The browser dashboard uses the same control server. Each computer has a distinct device credential. A device credential cannot manage the server or act as the owner. The computer must be awake, connected to the network, and running its agent to receive work.

The server is single-process. Run only one server against a data directory. Its SQLite-backed OS lock releases automatically after a crash; lock files remain on disk and must not be deleted during operation. Use a local filesystem or a local Docker named volume. Network filesystems and Docker Desktop bind mounts shared from macOS/Windows are not qualified for this lock. Node 22 may print an experimental SQLite warning; the service uses only the basic database/transaction API. Persist and protect that directory: it contains the owner token, device enrollment records, revocations, and audit metadata. Pairing codes are short-lived and held in memory; restart clears unused pairings. Completed call results are bounded and kept in memory, not permanently archived.

## Build from source

Use Node.js **22.13 or newer** and run these commands from the repository root:

```sh
npm ci --ignore-scripts
npm rebuild @vscode/ripgrep
npm run build
node dist/npm-scripts/verify-ripgrep.js
```

Skipping dependency lifecycle scripts avoids the upstream package's installation tracking and automatic setup steps. Then explicitly rebuild only the trusted `@vscode/ripgrep` package: its installer downloads the platform-specific search binary needed by agents. The explicit build compiles the application, and the last command checks that ripgrep is available. Complete these steps on every computer that will run an agent. The private entrypoint is `npm run self-host -- …`, or `node dist/self-host/cli.js …` after building.

## Start locally

Initialize the server once:

```sh
npm run self-host -- init --data-dir .self-host/server
npm run self-host -- serve --data-dir .self-host/server
```

The default address is `http://127.0.0.1:8787`. Initialization saves the owner token to `.self-host/server/owner-token` with private file permissions; it does not print the token. Open that file locally when you need to enter the token in the dashboard. Do not put its contents into a URL, shell argument, shared log, or committed client configuration.

Open the server address in a browser and enter the owner token. The dashboard holds it only in page memory and sends it in the `Authorization` header. It uses no cookies or browser storage for authentication. Sign out or reload the page to clear the token. The dashboard can create pairing codes, revoke devices, and refresh device status and audit activity; it does not execute commands.

## Enroll a computer

Create a one-use pairing file on the server machine:

```sh
npm run self-host -- pair --server http://127.0.0.1:8787 --token-file .self-host/server/owner-token --pairing-file .self-host/pairing-code
```

Pairing codes expire after five minutes. Transfer that private file to the computer you intend to enroll through a channel you control. Alternatively, create a code with **Add device** in the dashboard and save it to a private file on the target computer. The dashboard shows the code only at creation and clears it when hidden, expired, or signed out. Hiding it does not revoke a still-valid code.

On the target computer, build this repository and enroll:

```sh
npm run self-host -- enroll --server http://127.0.0.1:8787 --pairing-file .self-host/pairing-code --credentials .self-host/agent.json
```

The loopback example assumes the agent and server run on the same machine. For another computer, use the server's configured HTTPS origin, such as `https://commander.example.com`. Enrollment is a deliberate local action and creates the device credential file. A pairing code cannot be used twice. Remove the pairing file after enrollment; keep the agent credential private.

Start the enrolled agent with absolute workspace and state-directory paths:

```sh
npm run self-host -- agent --credentials .self-host/agent.json --workspace /absolute/path/to/workspace --state-dir /absolute/path/to/private-agent-state
```

Use paths appropriate to the target OS. The workspace is the initial allowed directory for file tools. The state directory is dedicated to this fork's engine configuration, tool history, usage records, and logs. Use a separate state directory for each agent; do not point it at another Desktop Commander installation's settings.

Keep the agent process running. It connects outward and does not open an incoming port on the computer. On interruption it closes its connection and local engine. Transient connection failures, including an unavailable server at startup, trigger retries with capped backoff. An access-policy HTTP 403 retries more slowly. Invalid credentials, revocation, protocol rejection, and replacement by another agent stop the agent with a clear diagnostic and a nonzero exit status. Run one agent per credential; starting another replaces the old instance without a reconnect fight. After a machine restart, start the agent again using the same credential and state paths.

List or revoke devices from the dashboard, or use the CLI:

```sh
npm run self-host -- devices --server http://127.0.0.1:8787 --token-file .self-host/server/owner-token
npm run self-host -- revoke --server http://127.0.0.1:8787 --token-file .self-host/server/owner-token --device-id DEVICE_ID
```

Revocation closes the current connection and prevents those credentials from reconnecting. To restore access, deliberately enroll the computer again with a new pairing code.

## Connect an MCP client

The endpoint is the server origin followed by `/mcp`:

```text
URL: https://commander.example.com/mcp
Transport: Streamable HTTP
Authorization: Bearer <owner token>
```

Use a client that can configure an authorization header securely. Supply the token through that client's secret mechanism instead of committing it to a project file. This private release does not implement OAuth browser sign-in, public registration, or the vendor's hosted account system. ChatGPT/plugin sign-in is not established by running a local MCP test; a client that requires OAuth needs additional integration.

Start with `list_devices`, then pass the intended `deviceId` with every device tool call, even when only one computer is online. An offline device never causes work to switch to another computer. The server advertises a stable, server-owned catalog even while all devices are offline; a call still requires its selected device to be connected and support that tool.

The remote catalog omits engine-configuration mutation, vendor feedback and onboarding, and UI-only operations that depend on unavailable resources. Policy changes belong to local administration, not ordinary AI tool calls. File operations, search sessions, terminal processes, and their output remain available through the curated catalog.

Long-running operations may return a call ID. Use `get_remote_call` to check that operation's result. An `unknown` outcome means the server cannot establish whether execution completed, for example after a connection loss or timeout. Inspect the machine's state before issuing another write or command. The service does not automatically replay uncertain operations. Normal long calls remain running and pollable; the server hard deadline is 31 minutes, slightly longer than the engine's 30-minute request deadline. A pre-execution refusal is reported as not started. If an operation executes but its output is too large, the response explicitly says it executed and should not be repeated just to recover output; the engine and other terminal sessions stay alive.

## Host behind HTTPS

For a remote deployment, choose a hostname, point its DNS records at the server, and place the control server behind a TLS proxy. The app requires HTTPS/WSS for non-loopback deployments. Configure one public origin and preserve its host header through the proxy; arbitrary forwarded headers are not used to select a trusted origin.

On a host with Caddy as the proxy, a process invocation can be:

```sh
npm run self-host -- serve --data-dir .self-host/server --host 127.0.0.1 --port 8787 --public-url https://commander.example.com
```

Proxy that hostname to `127.0.0.1:8787`. The example Caddyfile under `deploy/self-host` handles HTTPS and WebSocket upgrades. Keep the app's port private. The owner token controls all enrolled computers; protect access to it and to the server's persistent storage.

### Container example

The included Dockerfile builds the server and runs it as the non-root `node` user. `.dockerignore` keeps private `.self-host` state, environment files, Git data, and local logs/test artifacts out of the build context; the Dockerfile also copies only explicit application inputs. The Compose example runs the control server and Caddy, with separate named volumes for server state and TLS state. It publishes only Caddy's HTTPS/HTTP ports. This image runs the control server only and omits the agent's ripgrep binary download. Build and run agents on the computers whose files and commands you want to use, following the source setup above.

From the repository root, set your actual hostname in the environment (it is not a secret):

```sh
export COMMANDER_DOMAIN=commander.example.com
docker compose -f deploy/self-host/compose.yaml build
docker compose -f deploy/self-host/compose.yaml run --rm commander init --data-dir /data
docker compose -f deploy/self-host/compose.yaml up -d
```

The compose configuration requires `COMMANDER_DOMAIN`. Before starting it publicly, configure DNS and allow ports 80 and 443 to reach Caddy. The server has no published host port. `--host 0.0.0.0` is used inside its private container network so the proxy can reach it; the configured public URL remains the HTTPS origin.

The owner token is `/data/owner-token` in the `commander_data` volume. To obtain a local private copy without printing it to the terminal, redirect a read into a private file:

```sh
umask 077
docker compose -f deploy/self-host/compose.yaml exec -T commander cat /data/owner-token > /private/path/owner-token
```

Create the destination's parent directory first and choose a location outside the repository. Do not enable shell tracing. Open the resulting file locally to sign into the dashboard. The token is never embedded in Compose or passed as a process argument.

Stop with `docker compose -f deploy/self-host/compose.yaml down`. Do not add `--volumes` unless you intend to delete the persistent server and certificate state. Back up the private data volume and its ownership/permissions. Container builds, certificate issuance, and remote client connections need their own deployment verification; a successful source build does not establish those outcomes.

## Access, logs, and limitations

- The local engine runs with the agent user's OS permissions. Allowed-directory and command filters help bound normal operations, but they are not an OS sandbox. Use a dedicated OS account, container, or VM when stronger isolation is required.
- The self-host entrypoint uses separate local state and disables vendor telemetry, remote feature flags, onboarding, and eager browser downloading. Explicit PDF generation may need a compatible browser/runtime dependency; install and verify that dependency on the agent machine before relying on PDF tools.
- The server audit contains device IDs, tool names, timestamps, durations, and outcomes. It excludes command arguments, file contents, credentials, and result bodies. The private engine also redacts persisted call arguments and outputs. This reduces secret retention but means the audit cannot reconstruct the commands or file contents involved in an incident. Treat the agent state directory as private.
- Device tokens are stored as hashes on the control server; the agent stores the credential it needs to reconnect. Keep both agent credentials and the owner's token out of Git and shared logs.
- This is a single-owner, single-server-process release. Do not share its data directory between replicas. OAuth, multi-owner accounts, unattended agent installers, screen control, and a production hosting SLA are outside this release.
- On Windows, use PowerShell for terminal operations. The upstream `cmd.exe` adapter has a quoting edge when a command starts with a quoted executable and contains additional quoted arguments; that shell combination is not qualified by this release.
- Platform support follows the engine's Windows/macOS/Linux design; claim platform qualification only for environments actually tested. Public DNS/TLS, hosting, and a real AI client remain deployment checks until exercised.

## Attribution

The local file and terminal engine comes from [DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) under its MIT license. This fork retains the original license and attribution. Jimmy Remote Commander's private server, dashboard, and device transport do not require the proprietary Desktop Commander hosted service or use its brand assets.

### Upgrading early development state

A text `server.lock` from an earlier development build is refused by the new kernel-lock implementation. Stop every server using that data directory and verify they are stopped before removing that legacy PID file once. New builds retain a version marker at `server.lock` and a SQLite lock database; leave both in place. The marker prevents older binaries from opening the migrated directory. Never run multiple replicas against shared state or delete these files to bypass a running lock.

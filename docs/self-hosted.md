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

For a new Windows pilot checkout, clone the private feature branch. Compare the printed commit with the passing commit in the [pilot checks](https://github.com/Jimmy0429/remote-desktop-commander/pull/1/checks). If you already have the checked-out fork, run `git rev-parse HEAD` in it.

```sh
git clone --branch feat/self-hosted-remote --single-branch https://github.com/Jimmy0429/remote-desktop-commander.git
cd remote-desktop-commander
git rev-parse HEAD
```

Use Node.js **22.13 or newer** and run these commands from the repository root:

```sh
npm ci --ignore-scripts
npm rebuild @vscode/ripgrep
npm run build
node dist/npm-scripts/verify-ripgrep.js
```

Skipping dependency lifecycle scripts avoids the upstream package's installation tracking and automatic setup steps. Then explicitly rebuild only the trusted `@vscode/ripgrep` package: its installer downloads the platform-specific search binary needed by agents. The explicit build compiles the application, and the last command checks that ripgrep is available. Complete these steps on every computer that will run an agent. The private entrypoint is `npm run self-host -- …`, or `node dist/self-host/cli.js …` after building.

### Portable Windows USB file test

The Windows USB pilot includes an official Node.js runtime and a one-file agent. Choose the x64 ZIP for Intel/AMD Windows, or arm64 for Windows on ARM, and extract the whole folder. No separate Node.js, npm, Git or administrator setup is needed on the target. Obtain approval before running it on a work computer.

Start with **CHECK-USB.cmd** and enter `CHECK` to try a temporary, offline loopback test. **START-PILOT.cmd** is the separate paired test. It asks for an approved server address and a one-use code, or confirmation to reconnect with a saved identity. Its file operations are limited locally to the one disposable text file shown in the console. Each session uses a fresh workspace. The package has no remote terminal, no automatic startup, and stores its device credential under the user's protected LocalAppData. See the [included USB instructions](../deploy/windows-usb/README.txt).

To build from a committed revision, install locked build dependencies and run `node scripts/build-windows-usb.mjs --arch x64 --output Commander-USB-x64.zip` (or `--arch arm64`). The ZIP includes a build manifest, runtime and dependency licenses; the builder writes a SHA-256 file beside it. Native Windows qualification runs the .cmd launchers from an extracted archive without a system Node on PATH.

### Windows storage and first pilot

Use a supported Windows installation with local NTFS storage and Windows PowerShell available. Run the agent as your normal user. Windows defaults now put state under `%LOCALAPPDATA%\JimmyRemoteCommander`, outside the checkout: `server\owner-token`, `agent.json`, and `pairing-code`. Explicit path options still override the defaults. The Unix examples below use explicit `.self-host` paths; for Windows prefer the LocalAppData defaults or explicit paths there.

New state directories receive a protected Windows DACL before secrets are written. Existing storage must already grant access only to the current user, SYSTEM, and Administrators. Credential reads recheck the file and its parent; links, reparse paths, unknown owners, broad grants, unavailable ACLs, and unsafe parent replacement permissions are refused. Names are compared by SID, not localized account names. This protects against other unprivileged accounts; it does not protect secrets from an administrator or another process running as you.

If an existing dedicated state directory has unsafe permissions, stop its processes and explicitly repair it:

```powershell
node dist/self-host/cli.js protect --data-dir "$env:LOCALAPPDATA\JimmyRemoteCommander\server"
```

`protect` is limited to existing directories containing recognizable application state. It refuses home/volume/repository roots, unrelated files, multiply linked files, and reparse paths. It does not silently change workspace permissions. For a custom credential filename or unrelated contents, create a fresh dedicated directory and move only the required state after protecting it. Keep state on local storage, outside OneDrive/shared folders.

For a disposable same-computer pilot, use a dedicated standard account or a Windows VM with test files. Run the following block from the built repository in PowerShell. It initializes fresh server state and serves it on loopback. To resume an existing pilot, start its server with `serve` using its original data directory.

```powershell
& {
    $ErrorActionPreference = 'Stop'
    node dist/self-host/cli.js init
    if ($LASTEXITCODE -ne 0) { throw 'Server initialization failed.' }
    node dist/self-host/cli.js serve
}
```

In a second PowerShell window at the same repository, run the full block. It creates a new workspace, requests a pairing from that server, and starts the agent with the identity returned by enrollment.

```powershell
& {
    $ErrorActionPreference = 'Stop'
    $jrcServer = 'http://127.0.0.1:8787'
    $jrcWorkspace = Join-Path $env:LOCALAPPDATA ('CommanderPilot-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $jrcWorkspace | Out-Null
    node dist/self-host/cli.js pair --server $jrcServer --token-file "$env:LOCALAPPDATA\JimmyRemoteCommander\server\owner-token"
    if ($LASTEXITCODE -ne 0) { throw 'Pairing failed. Check the server and existing pairing file.' }
    node dist/self-host/cli.js enroll --server $jrcServer --name "$env:COMPUTERNAME pilot" --start-agent --workspace $jrcWorkspace
    if ($LASTEXITCODE -ne 0) { throw 'See the enrollment or agent diagnostic above.' }
}
```

`enroll --start-agent` requires a fresh credential path. It publishes the complete credential, verifies the saved server and device identity against the enrollment response, removes the used pairing file, and launches that enrollment in the foreground. A failed enrollment leaves the pairing file and never starts an old agent. Record the printed device ID and compare it with the online device in the owner dashboard. Keep both windows open while testing. The [pilot handoff](../CONTINUE-TOMORROW.md) lists the file and terminal checks.

## Start locally

Initialize the server once:

```sh
npm run self-host -- init --data-dir .self-host/server
npm run self-host -- serve --data-dir .self-host/server
```

The default address is `http://127.0.0.1:8787`. Initialization saves the owner token to `.self-host/server/owner-token` with private file permissions; it does not print the token. Open that file locally when you need to enter the token in the dashboard. Do not put its contents into a URL, shell argument, shared log, or committed client configuration.

Open the server address in a browser and enter the owner token. The dashboard holds it only in page memory and sends it in the `Authorization` header. It uses no cookies or browser storage for authentication. Sign out or reload the page to clear the token. The dashboard can create pairing codes, revoke devices, and refresh device status and audit activity; it does not execute commands.

## Enroll a computer

Before transferring a pairing file to a new Windows agent computer, build the repository there and prepare its default private state directory. These commands are for a new, empty destination; if it already exists, follow the existing-storage guidance above instead.

```powershell
$jrcAgentState = Join-Path $env:LOCALAPPDATA 'JimmyRemoteCommander'
New-Item -ItemType Directory -Path $jrcAgentState -ErrorAction Stop | Out-Null
node dist/self-host/cli.js protect --data-dir $jrcAgentState
if ($LASTEXITCODE -ne 0) { throw 'Private state preparation failed; do not transfer credentials.' }
```

Save or copy the pairing file into `$jrcAgentState\pairing-code` through your private transfer channel. Create the file in this protected directory so it inherits the directory's permissions; do not move a file while preserving permissions from another directory. The enrollment command rechecks the file before using it.

Create a one-use pairing file on the server machine. The loopback commands below apply to a local server without `--public-url`; when a public URL is configured, use that exact HTTPS origin for every CLI request, including requests from the server machine:

```sh
npm run self-host -- pair --server http://127.0.0.1:8787 --token-file .self-host/server/owner-token --pairing-file .self-host/pairing-code
```

Pairing codes expire after five minutes. Transfer that private file to the computer you intend to enroll through a channel you control. Alternatively, create a code with **Add device** in the dashboard and save it to a private file on the target computer. The dashboard shows the code only at creation and clears it when hidden, expired, or signed out. Hiding it does not revoke a still-valid code.

On a Unix target, build this repository and enroll with explicit local paths:

```sh
npm run self-host -- enroll --server http://127.0.0.1:8787 --pairing-file .self-host/pairing-code --credentials .self-host/agent.json
```

The loopback example assumes the agent and server run on the same machine. For another computer, use the server's configured HTTPS origin, such as `https://commander.example.com`. Enrollment is a deliberate local action and creates the device credential file. A pairing code cannot be used twice. Remove the pairing file after enrollment; keep the agent credential private.

On the new Windows computer, use the LocalAppData defaults prepared above. Replace the example HTTPS origin with the exact address of your private server, then run this block from the built repository.

```powershell
& {
    $ErrorActionPreference = 'Stop'
    $jrcServer = 'https://commander.example.com'
    $jrcWorkspace = Join-Path $env:LOCALAPPDATA ('CommanderPilot-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $jrcWorkspace | Out-Null
    node dist/self-host/cli.js enroll --server $jrcServer --name "$env:COMPUTERNAME pilot" --start-agent --workspace $jrcWorkspace
    if ($LASTEXITCODE -ne 0) { throw 'See the enrollment or agent diagnostic above.' }
}
```

For an already enrolled computer, use the server origin and device ID from the successful enrollment, as shown in the owner dashboard. Supply the original workspace and credential paths. The CLI verifies the requested identity against the saved credential before connecting.

```sh
npm run self-host -- agent --server https://commander.example.com --device-id DEVICE_ID --credentials .self-host/agent.json --workspace /absolute/path/to/workspace --state-dir /absolute/path/to/private-agent-state
```

Use paths appropriate to the target OS. The workspace is the outer limit for private file tools. A valid local list of allowed directories can narrow it further. An empty, missing or malformed list in an existing configuration denies file access. If you deliberately move the workspace, use a fresh engine state directory or update the saved allowlist. Terminal commands still run with all permissions of the agent account. The state directory is dedicated to this fork's engine configuration, tool history, usage records, and logs. Use a separate state directory for each agent; do not point it at another Desktop Commander installation's settings.

Keep the agent process running. It connects outward and does not open an incoming port on the computer. On interruption it closes its connection and local engine. Transient connection failures, including an unavailable server at startup, trigger retries with capped backoff. An access-policy HTTP 403 retries more slowly. Invalid credentials, revocation, protocol rejection, and replacement by another agent stop the agent with a clear diagnostic and a nonzero exit status. Run one agent per credential; starting another replaces the old instance without a reconnect fight. After a machine restart, start the agent again using the same credential and state paths.

List or revoke devices from the dashboard, or use the CLI:

```sh
npm run self-host -- devices --server http://127.0.0.1:8787 --token-file .self-host/server/owner-token
npm run self-host -- revoke --server http://127.0.0.1:8787 --token-file .self-host/server/owner-token --device-id DEVICE_ID
```

Revocation closes the current connection and prevents those credentials from reconnecting. To restore access, stop the old agent and deliberately enroll the computer again with a new pairing code. Enrollment never overwrites an existing credential file: choose a fresh `--credentials` path, or deliberately remove the old credential after confirming its revocation. Start the replacement agent with the matching credential path and its intended state directory.

### Recover an interrupted enrollment

If enrollment reports a lost response or interrupted credential write, the server may already have consumed the pairing code. In the owner dashboard, find the new registration by its printed device ID. When the reply never arrived, use the owner's `devices` command on that server to compare device names and creation times. Revoke an identified, unusable registration before issuing a fresh pairing. If you cannot distinguish it from other devices, resolve its identity before revoking anything.

When a stopped enrollment leaves only a `<credentials>.pending` file, treat it as secret. Confirm that no enrollment process is active and resolve the server registration before removing that leftover or using a fresh credential path. If both names exist, the final credential may already be complete. Use the original server and confirmed device ID with `agent --server URL --device-id ID` to resume. A standalone `enroll` leaves the consumed pairing file for local cleanup after success.

## Connect an MCP client

The endpoint is the server origin followed by `/mcp`:

```text
URL: https://commander.example.com/mcp
Transport: Streamable HTTP
Authorization: Bearer <owner token>
```

Use a client that can configure an authorization header securely. Supply the token through that client's secret mechanism instead of committing it to a project file. This private release does not implement OAuth browser sign-in, public registration, or the vendor's hosted account system. ChatGPT/plugin sign-in is not established by running a local MCP test; a client that requires OAuth needs additional integration.

### Desktop extension

On the client computer, run `npm run build:mcpb` in the verified private checkout. Open the generated `jimmy-remote-commander-<version>.mcpb` in a desktop client with MCPB support. Select your private server origin and the absolute path to its protected client credential file. The extension bundles the private bridge and requires Node 22.13 or newer. The credential file stays outside the extension.

After connecting, call `list_devices` and compare the device ID with the one printed during enrollment. For Claude Code, Cursor or Gemini CLI, see the [client plugin guide](../plugins/private/README.md).

### Desktop clients using stdio

Desktop clients that launch a local MCP process can use the bridge. Configure the client to launch **Node directly**, with the compiled CLI and `bridge` arguments; do not launch through `npm`, whose status messages can corrupt MCP stdout. The bridge reads the credential from its private file. No token is placed in this configuration or the process arguments.

Example Windows configuration (replace the paths and server origin):

```json
{
  "mcpServers": {
    "jimmy-remote-commander": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\YOU\\Projects\\JimmyRemoteCommander\\dist\\self-host\\cli.js",
        "bridge",
        "--server", "https://commander.example.com",
        "--token-file", "C:\\Users\\YOU\\AppData\\Local\\JimmyRemoteCommander\\client\\owner-token"
      ]
    }
  }
}
```

The credential file must contain the server's actual owner token and pass the same private-storage checks. From the built repository, create and protect a new dedicated client directory **before** transferring the token:

```powershell
$jrcClientState = Join-Path $env:LOCALAPPDATA 'JimmyRemoteCommander\client'
New-Item -ItemType Directory -Path $jrcClientState -ErrorAction Stop | Out-Null
node dist/self-host/cli.js protect --data-dir $jrcClientState
if ($LASTEXITCODE -ne 0) { throw 'Private client preparation failed; do not transfer the token.' }
```

If the directory already exists, use the existing-storage guidance above instead. Save or copy the actual owner token to `$jrcClientState\owner-token` through your private transfer channel, letting the new file inherit the protected destination permissions. Do not move it while preserving permissions from another directory. Point the client's `--token-file` argument at that file. The configuration format belongs to the chosen client; a successful bridge test is not proof that every client or the ChatGPT cloud connector accepts this format.

The bridge exposes the private server's tool catalog, supports asynchronous call-ID polling, refuses redirects, and caps request/response sizes and waiting time. It does not retry tool submissions. A failed response may leave execution uncertain; inspect device state before repeating a write. Closing the desktop client closes its bridge, not the remote agent. The owner token still controls all enrolled devices; separate revocable client credentials are not implemented yet.

Start with `list_devices`, then pass the intended `deviceId` with every device tool call, even when only one computer is online. An offline device never causes work to switch to another computer. The server advertises a stable, server-owned catalog even while all devices are offline; a call still requires its selected device to be connected and support that tool.

The remote catalog omits engine-configuration mutation, vendor feedback and onboarding, and UI-only operations that depend on unavailable resources. Policy changes belong to local administration, not ordinary AI tool calls. File operations, search sessions, terminal processes, and their output remain available through the curated catalog.

Long-running operations may return a call ID. Use `get_remote_call` to check that operation's result. An `unknown` outcome means the server cannot establish whether execution completed, for example after a connection loss or timeout. Inspect the machine's state before issuing another write or command. The service does not automatically replay uncertain operations. Normal long calls remain running and pollable; the server hard deadline is 31 minutes, slightly longer than the engine's 30-minute request deadline. A pre-execution refusal is reported as not started. If an operation executes but its output is too large, the response explicitly says it executed and should not be repeated just to recover output; the engine and other terminal sessions stay alive.

### Editing files and retrieving command results

For this pilot, build the server and Windows agent from the same 0.3.4 checkout and use the matching client. An existing installation needs its server and agent processes restarted after the build. The agent coordinates concurrent text edits, document edits and file writes to the same file. Edits to different lines of one file can both complete. An external editor, a PowerShell command, or a second agent process can still change the same file independently. Back up important files before sustained editing: interrupting a text rewrite can leave a partial file.

For PDF page insertions and deletions with `write_pdf`, supply the existing source in `path` and a **new filename** in `outputPath`, such as `notes-edited.pdf`. Choose a local NTFS destination on Windows. Private PDF page edits made with `edit_block` use the same rule, with the destination in `options.outputPath`. Both tools refuse an omitted or occupied destination and publish the finished file without replacing an existing file. Markdown-to-PDF creation and standalone local `edit_block` keep their existing calling conventions. A hard stop during publication can leave a `.commander-<uuid>.tmp` staging file in the chosen folder.

When a long operation returns a call ID, poll it with `get_remote_call`. Finished results are retained by completion order, subject to the count, age, and memory limits. During a server restart, the audit retains metadata for interrupted calls and marks them as having an unknown outcome. The result bodies themselves live in memory.

## Host behind HTTPS

For a remote deployment, choose a hostname, point its DNS records at the server, and place the control server behind a TLS proxy. The app requires HTTPS/WSS for non-loopback deployments. Configure one public origin and preserve its host header through the proxy; arbitrary forwarded headers are not used to select a trusted origin. Once `--public-url` is set, use that exact HTTPS origin for all CLI, agent, and bridge connections, even from the server machine; direct loopback requests are rejected by the Host check.

On a host with Caddy as the proxy, a process invocation can be:

```sh
npm run self-host -- serve --data-dir .self-host/server --host 127.0.0.1 --port 8787 --public-url https://commander.example.com
```

For Caddy running directly on that host, proxy the hostname to the local process:

```caddyfile
commander.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Replace the example hostname with your configured hostname. The bundled `deploy/self-host/Caddyfile` is for the Compose deployment below: its upstream is `commander:8787`, the container's private network name. Keep the app's port private. The owner token controls all enrolled computers; protect access to it and to the server's persistent storage.

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

Create a dedicated destination directory outside the repository first. On Unix it must be owned by you and have mode 700, in addition to the file having mode 600; a private file inside a shared directory is refused. On Windows use the dedicated protected storage described above. Do not enable shell tracing. Open the resulting file locally to sign into the dashboard. The token is never embedded in Compose or passed as a process argument.

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

# Jimmy Remote Commander

This plugin connects your AI client to the private Jimmy Remote Commander server. Its 25 tools include device selection, file operations, searches, terminal sessions, and result polling.

Build the verified fork on the **client** machine using the [source setup](../../docs/self-hosted.md#build-from-source). Keep that checkout at the same absolute path while the plugin is installed. Pair the target computer and start its agent. Transfer the owner credential file privately to the client using the [private-file instructions](../../docs/self-hosted.md#desktop-clients-using-stdio).

## Configure the client

Open a normal PowerShell window in the built checkout. Set these **client** variables before launching Claude Code or Cursor. Replace the example origin with your own. For a pilot with the server on this same client computer, use `http://127.0.0.1:8787`.

```powershell
$env:JRC_CLIENT_ROOT = (Get-Location).Path
$env:JRC_NODE = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
$env:JRC_SERVER_URL = 'https://commander.example.com'
$env:JRC_TOKEN_FILE = Join-Path $env:LOCALAPPDATA 'JimmyRemoteCommander\client\owner-token'
```

For a disposable same-computer pilot using the token created by `init`, set `JRC_TOKEN_FILE` to the absolute path to `JimmyRemoteCommander\server\owner-token` under LocalAppData. The last setting always holds a **file path**. The bridge checks the file's permissions and reads the credential itself. On macOS or Linux, export the same four variables with absolute POSIX paths.

The client must inherit these settings. For a desktop app, quit any running instance before starting it from the configured environment. To use the Windows Start menu later, save the four values as user environment variables and restart the app. After an upgrade, rebuild the selected checkout and refresh the installed plugin from it. The launcher checks that the plugin, checkout, and compiled code report the same version before starting the bridge.

### Claude Code

From PowerShell in the configured checkout:

```powershell
claude plugin marketplace add "$env:JRC_CLIENT_ROOT"
claude plugin install jimmy-remote-commander@jimmy-private-tools
```

Start Claude Code in your working project and open `/mcp`. The Jimmy Remote Commander server should connect. Ask it to list your paired computers, compare the reported device ID with the private dashboard, and use a disposable file for the first read/write. The registered marketplace points to this local checkout.

### Cursor and other clients

For Cursor, install the private plugin from a plugin marketplace that has access to this fork. Its marketplace entry points to `plugins/private`. For an individual local pilot, use the direct Node configuration in [Desktop clients using stdio](../../docs/self-hosted.md#desktop-clients-using-stdio) in Cursor's MCP settings. It launches the same private bridge.

Gemini CLI users can link the repository as an extension with `gemini extensions link <checkout>`. Enter the built checkout path, server origin, and private credential file path when configuring the extension. Gemini launches Node from its executable search path. Node 22.13 or newer is required.

If another client cannot substitute environment variables, use the same direct configuration with absolute paths. The bridge uses the selected checkout's installed dependencies and connects to the configured origin. A missing build, private credential, or server prevents a successful connection.

[Claude MCP configuration](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson) · [Cursor MCP configuration](https://cursor.com/docs/mcp) · [Gemini extension settings](https://geminicli.com/docs/extensions/reference/#extension-settings)

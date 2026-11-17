# Continue the Windows pilot

The owner paused **installation**, not approval to build: a different Windows computer will be available tomorrow. Do not install onto either previously listed Avtec computer. No target Windows PC or permanent host has been selected, and no public service has been deployed.

## Start here

1. Read `docs/self-host-verification.md` for the final checkpoint evidence and limitations. Read `docs/self-hosted.md` for commands and credential handling.
2. Check `git status --short` and the feature branch `feat/self-hosted-remote`. The work is in [draft PR #1](https://github.com/Jimmy0429/remote-desktop-commander/pull/1); `main` is the upstream base. Do not accidentally install `main` or merge the draft as part of resuming.
3. Identify the owner's new Windows computer and its Windows version, architecture, available Node runtime, and intended working directory. Use normal user privileges. No UAC bypass, firewall-wide opening, or LocalSystem agent is part of this design.
4. Decide a pilot server reachable from that PC. Recommended permanent architecture: a small always-on Linux host/VM with the included non-root container and HTTPS proxy; Windows agents make outbound connections. Existing hardware is preferable before buying hosting. The user asked for our recommendation but has not chosen or purchased a host.
5. Build the exact verified feature-branch commit, create protected local state outside the working files, and perform one-use enrollment. Use local loopback only when server and agent are on the same computer; another computer requires the configured HTTPS origin.
6. Connect the chosen real AI client through the private bridge or supported authenticated HTTP transport. Exercise a disposable workspace first: Unicode filenames/content, read/write/edit/move/search, PowerShell 5.1 and 7 if available, interactive output, process cleanup, disconnect/reconnect, and revocation.
7. Only after the manual agent works, add and test an explicit per-user logon startup option if desired. It must use normal privilege, no stored password, correct battery/runtime settings, one instance, and no restart loop after revocation or replacement. It is not implemented in this checkpoint.

## What to preserve

- Private single-owner service; no public signup.
- Exact server origin and TLS validation; no credential-bearing redirects.
- Explicit `deviceId` for every remote operation; never switch devices silently.
- No automatic replay of uncertain writes or commands. Until a remote-call discovery tool exists, a lost call ID requires inspecting the machine's state.
- Private credential files, no tokens in shell arguments or committed client configurations.
- Agent workspace limits are not an OS sandbox. Terminal commands have the agent user's privileges.
- Vendor telemetry/remote flags remain disabled on the self-host path.
- Fable collaboration is authorized. Installed Claude Code has been run explicitly with `--model fable`; response metadata confirmed `claude-fable-5-2`. Review source-only snapshots, not runtime credentials or unrelated files. Prior review receipts are under ignored `.self-host/fable-review/`.

## Remaining product decisions

See `docs/self-host-capabilities.md` for precise parity. Remaining options include independently revocable MCP client tokens, discoverable remote-call history, protocol version negotiation, a deliberate remote disconnect flow, and an operator-controlled configuration workflow. Native screenshot/mouse desktop control is not part of the current engine and must not be implied by the product name.

The November 17 scope and task record are in `docs/superpowers/specs/2026-11-17-windows-readiness-design.md` and `docs/superpowers/plans/2026-11-17-windows-readiness.md`. Record fresh results after tomorrow's actual machine tests; CI is not proof that the owner's Windows machine is already installed or reachable.

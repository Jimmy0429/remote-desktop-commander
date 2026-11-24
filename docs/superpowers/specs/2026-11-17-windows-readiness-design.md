# Windows readiness and next-day checkpoint

## Intent and authorization

The owner wants a secure, effective private Remote Commander for primarily Windows computers, retaining the original file and terminal capabilities and improving practical operation. The existing private-server design and implementation are approved. On November 17 the owner chose a different Windows computer for installation **tomorrow**, and asked for a checked, stable stopping point tonight. Do not enroll or change either previously discovered Avtec device. The new computer and permanent host are not selected yet.

## Tonight's deliverable

Complete and verify the bounded improvements already in progress: Windows credential/state protection and a desktop MCP stdio bridge. Audit inherited dependencies, apply narrow compatible patches, and record current tool parity and remaining release gates. Preserve the outbound-agent architecture, explicit device selection, no-replay behavior, and disabled self-host vendor telemetry. No public deployment, client-account changes, scheduled startup, or device installation tonight.

## Design choices

- Keep the approved TypeScript/Node 22.13+ engine and private relay. Replacing them with an unrelated remote desktop stack would discard the existing file/search/terminal implementation and does not solve the immediate readiness gaps.
- Protect application state with actual Windows DACLs. POSIX modes alone do not protect Windows credentials. Validate trusted SIDs and owner, reject links/reparse targets, and establish protection before writing secrets. Never silently change an arbitrary existing workspace's permissions. Provide an explicit protection command for a dedicated state directory and fail closed on unsafe storage.
- Add a local stdio-to-HTTP bridge for desktop MCP clients. The bridge reads the existing private bearer credential through CLI file handling, pins the configured origin, refuses redirects, and never retries a tool submission. Its stdout carries only MCP messages. This preserves the approved single-owner token design; independently revocable client credentials remain a later hardening item, not a claim of this checkpoint.
- Keep all 23 current engine capabilities. Remote configuration mutation remains outside the AI surface because it can relax local policy. Vendor account, billing, and approval-review operations have no equivalent private account system. Record remaining functional gaps explicitly.
- Permanent-host recommendation: an always-on Linux host/VM running the supplied non-root container, with Windows agents connecting outward. This is a recommendation, not a hosting purchase or deployment authorization. Tomorrow's first target can be qualified before selecting permanent hosting.

## Verification

Run fresh build and focused self-host tests, including real SDK bridge traffic, denied authentication/redirect cases, and Windows-native ACL tests in GitHub Actions. Run appropriate inherited compatibility tests for changed dependencies and path handling. Report OS skips and residual dependency findings. Do not equate CI with testing the owner's actual Windows PC or configuring an AI desktop app.

## Deferred until the Windows pilot

Native installation and real desktop-client connection; PowerShell 5.1/7 Unicode and interactive process coverage; controlled per-user logon startup with battery/timeout policy and fatal-exit handling; real network TLS/reconnect verification; optional client-token separation, remote-call discovery, and protocol version negotiation. Screen streaming and mouse control are outside the current Desktop Commander file/terminal engine.

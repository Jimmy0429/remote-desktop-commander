# Decisions from the Fable 5.2 review

The user requested collaboration with their installed Anthropic Fable 5.2. Codex briefed it using a source-only review snapshot, verified the actual model identifier `claude-fable-5-2`, and exchanged challenges and corrections. No runtime credentials, private computer files, or unrelated conversations were included. Raw review transcripts stay in ignored local files.

## Changes supported by reproduced failures

| Finding | Decision and verification |
| --- | --- |
| PID file survived a crash and prevented restart | Hold a SQLite exclusive transaction for the service lifetime. SIGKILL releases the kernel lock; competing and paused live writers remain excluded. Keep the inode and a version marker, including across shutdown. |
| Rejected WebSocket upgrades could retain sockets or crash on reset | Own socket error handling immediately and close rejected sockets after a bounded response flush. Tests cover reset peers and more than 256 half-open attempts. |
| localhost POST Origin was rejected | Admit exact local aliases on the actual local port only when no public origin is configured. Keep configured public origins strict. |
| Offline clients saw no device tools and device descriptions were trusted | Publish a server-owned static catalog; retain only device capability names. Compare all 23 input schemas and operation annotations with the actual engine. |
| Duplicate agents fought through reconnects | Deliver a distinct replacement close code; the replaced agent exits with a diagnostic while the new one remains connected. Ignore stale socket close events. |
| Initial network loss stopped an unattended agent | Retry transient startup/connection failures, with cancellation and explicit diagnostics. Retry HTTP 403 more slowly; invalid credentials and explicit revocation remain fatal. |
| Unknown was used for definite refusals | Report not-started and executed-with-unavailable-output distinctly. A duplicate refusal does not finish the original pending call. |
| A 5 MiB read closed the stdio engine | Bound complete outbound messages before pipe writes. Return an explicit executed/result-too-large response, preserving other terminal sessions and subsequent reads. |
| Missing target could select the wrong sole online computer | Require deviceId for every device tool call, matching the advertised schema. |
| Result pruning repeatedly serialized retained content | Cache each completed result's serialized size. |

## Tradeoffs discussed

- Fable initially proposed time-based stale-lock takeover. Codex challenged it because a paused live process could become a second writer after resuming. Both agreed on a kernel-released lock. Node 22.13 is the minimum because [built-in SQLite no longer needs a flag from that version](https://nodejs.org/api/sqlite.html). The lock database uses DELETE journaling, zero busy timeout, a committed initialization, and a write-free lifetime EXCLUSIVE transaction. Only local filesystems and local Docker named volumes are qualified; do not delete active lock files.
- Legacy PID locks are not silently deleted: an older binary may still be running. A persistent version marker blocks old binaries after migration. This conservative migration rule was retained despite Fable's suggestion to remove obsolete locks automatically.
- Unknown outcomes remain final and operations are never automatically replayed. The normal hard deadline is now 31 minutes, beyond the engine's 30-minute request deadline, so ordinary long work stays running and pollable. Disconnects or a genuine hard deadline still require inspecting state before another side effect. Durable late-result recovery is future work.
- Command and content history remains redacted by default. This avoids retaining secrets, with the explicit cost that the audit cannot reconstruct the full commands or file contents involved in an incident. Opt-in device-local forensic logging needs its own retention and access design.
- A private VPN with TLS and a desktop client is the preferred first deployment boundary. No VPN, host, or real client was configured by the build task. Public access should wait for further dependency review and separate revocable client credentials; OAuth depends on the chosen client's requirements and should use a maintained implementation.
- Protocol/build-version negotiation, per-client tokens, optional device-side tool profiles, and durable result redelivery remain future features. They are not claimed by this first version.

See [verification results](self-host-verification.md) for test scope and remaining inherited dependency findings. A green test suite does not mean a clean dependency audit or a verified public deployment.

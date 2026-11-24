---
name: paired-computers
description: Work with files, searches and terminal sessions on a computer paired with the user's private Jimmy Remote Commander server.
---

Call `list_devices` and identify the computer the user intends. Supply its exact `deviceId` on every device call, including when a single device is online. File paths belong to the selected computer. Use its platform and configured workspace to choose paths.

For an operation still running, poll the returned call ID with `get_remote_call`. When execution is uncertain, inspect the device state before repeating a write or command. Sign-in, pairing and revocation belong to the owner's dashboard or CLI. Keep credential values out of prompts and tool calls.

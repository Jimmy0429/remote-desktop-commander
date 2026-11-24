Jimmy Remote Commander USB - Windows one-file pilot

No system Node.js or npm installation is needed. Choose x64 for Intel/AMD
Windows, or arm64 for Windows on ARM. Extract the entire ZIP to an empty
folder on a USB drive. Run the .cmd files from that folder, outside the ZIP.
Leave runtime, app and the launcher together.

On an employer-managed PC, get approval for this agent before running either
launcher. Follow your normal IT process if Windows or company policy blocks
the package. The Node runtime is an official Node.js distribution; the
Commander launchers are project builds and are not publisher-signed. The
CMD launchers stop before starting Node if NODE_OPTIONS or NODE_PATH is set.
Ask IT to review a customized environment; keep company controls in place.

FIRST TEST
Double-click CHECK-USB.cmd. Read the prompt and enter CHECK. The self-test
uses loopback on this PC. It creates a new temporary pilot workspace under
LocalAppData, writes and reads one dummy pilot-check.txt, reports the result
and cleans up its test state. No Pi address or pairing code is needed.

OPTIONAL PAIRED TEST
Use START-PILOT.cmd only with an approved reachable private Commander server.
Use HTTPS for an off-machine server. A 127.0.0.1 address always refers to the
computer running this package (or its own approved local forwarding setup).
The existing Mac-to-Pi SSH connection does not connect the Windows PC.
Do not open a firewall port or change endpoint security for the offline check.

At the console, enter the server origin. Type PAIR and enter a fresh one-use
code from the owner's dashboard (Add device). Supply only the pairing code.
The owner's token stays with the owner. On a later run the console shows the
saved server and device ID and asks for START before reconnecting.

The USB pilot accepts only small text reads and writes to pilot-check.txt in
the fresh workspace printed by the launcher. It does not expose a terminal,
process tools, file browsing or URL downloads. For a paired test, use the
displayed device ID and exact pilot file path when asking the client to write
and read the dummy file. The shared server may list other tool names for
other device types. Those tools cannot run on this USB pilot.

STOP AND CLEAN UP
Press Ctrl+C in the foreground agent console before removing the USB drive.
There is no startup task or Windows service. The one-device credential and
paired test workspaces are local to the Windows user, not on the USB drive.
Both the reusable device credential and paired dummy files remain on this
PC after a paired session ends. To retire it, stop the agent, revoke the
exact device ID in the owner's dashboard, then remove only this folder
from the Windows user profile if your IT policy permits:

    %LOCALAPPDATA%\JimmyRemoteCommander\usb-pilot

Keep any other JimmyRemoteCommander folders. CHECK alone creates and
cleans a separate temporary test directory and leaves no saved pairing.

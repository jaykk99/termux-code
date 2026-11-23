# Android device capabilities

Termux Code includes a `device` agent tool with **21 concrete Android actions**.
This is actual Termux:API command execution on the phone, not simulated access
or a remote cloud model magically taking over Android. Use `/device` to see
which commands are currently installed; it does **not** claim Android
permissions have been granted.

## One-time setup

1. Install compatible **Termux** and **Termux:API** Android apps from the same
   source (for example F-Droid; avoid mixing incompatible signing keys).
2. In the Termux shell, run `pkg update && pkg install termux-api`.
3. In Android Settings, allow Termux:API the permissions you want it to
   exercise. Contacts, SMS, camera, location and notifications have different
   permission/notification-listener requirements. Some Android versions
   restrict these APIs further.
4. For shared files/photos, run `termux-setup-storage` and grant shared-storage
   access if you want it. This does not remove Android app sandboxing.
5. Run `termux-code`, then `/device` for a command availability report.
   Ask the agent to use `device` for a particular action. An accessible
   model/tool route is required. Horde workers may ignore the text protocol.

## Exposed actions

| Action | Result |
| --- | --- |
| `status` | Which Termux:API commands are installed; permission warning |
| `battery`, `wifi_info`, `wifi_scan` | Battery and network diagnostics |
| `camera_info`, `camera_photo` | List cameras or capture a JPEG in current workspace |
| `sensor_list` | List device sensors |
| `volume_get`, `volume_set` | Read or adjust audio streams |
| `clipboard_read`, `clipboard_write` | Read or update clipboard |
| `location` | Read user-approved current location |
| `contacts`, `notifications`, `sms_read` | Return at most 20 records |
| `notify`, `speak`, `vibrate`, `torch` | Local notification, speech, vibration and flashlight |
| `open_url` | Open an HTTP(S) page in an Android browser |
| `call` | Request a carrier phone call with explicit confirmation |

The existing `phone` tool continues to offer SMS sending, telephony number
lookup and opening email drafts (not automatic email account creation).

Every private read, call, camera photo, clipboard modification, and device
setting change requires an explicit approval prompt **on the phone**. Commands
use fixed executable names and argument arrays rather than a generated shell
string. Camera photos must be named with a simple `.jpg` file inside the
current workspace, and existing files are not overwritten.

## What this does NOT grant

- Android does not give Termux blanket access to other apps' private files,
  accounts, bank apps, hidden screens or other users' messages.
- It does not install Termux:API or silently grant its permissions.
- It does not provide root, bypass Android permissions, automatically enable
  Accessibility Service or remotely control arbitrary app interfaces.
- On devices with Android's background restrictions, a command can be present
  but fail or hang; the integration times it out and reports the failure.
- Changing the LLM does not change Android permissions. A model without
  native function calling may have difficulty emitting valid tool calls.

For project and command-line work, the agent also has workspace-scoped file
tools, approved shell commands, browser tooling and the optional ReconAnything
connector. You can ask it to inspect code, change files, run tests and use
the phone APIs as a multi-step task, but actual results depend on the model,
installed apps and permissions.

Automated tests stub the Android APIs. **Real phone setup and hardware
verification must still be done on the user's own Android device.**

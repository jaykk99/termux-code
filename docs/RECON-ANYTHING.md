# ReconAnything ↔ termux-code

The Termux agent now has a **native `recon_anything` tool**, backed by the existing
[`jaykk99/recon-anything`](https://github.com/jaykk99/recon-anything)
API. No MCP SDK, new API key provider, or custom Python wrapper is required by
termux-code. It works from the CLI's regular model tool loop (including when
the model itself runs through the hosted gateway; the scanner requests are
still made **on the phone**).

The bridge selects ReconAnything for prompts about authorized hacking,
pentesting, OSINT, vulnerability scans, or bug-bounty reconnaissance.
It can check health, discover plugins, submit passive scans, poll progress,
list recent runs and retrieve/filter findings. It does not claim a scan has
succeeded until the backend returns a real result.

## Start ReconAnything

The scanner backend must be running. For the same Android phone, follow
[ReconAnything's Termux setup](https://github.com/jaykk99/recon-anything/blob/master/local-run/README.md):

```sh
pkg install -y git
git clone https://github.com/jaykk99/recon-anything.git
cd recon-anything
bash local-run/termux-setup.sh    # one-time
bash local-run/termux-start.sh    # leave running
```

The API runs on port **8000**. The UI runs on **3000**, which is *not* the
port to configure in the agent. If ReconAnything is instead running on Linux,
run `RECON_BIND_HOST=0.0.0.0 bash local-run/linux-start.sh` there to
opt into private-LAN API access (ReconAnything PR #211 adds the bind setting),
then use its reachable LAN address in the command below.
`127.0.0.1` is only correct if both apps run on the same phone.

## Configure once inside termux-code

```text
/recon url http://127.0.0.1:8000
/recon code YOUR_LOCAL_RECON_ACCESS_CODE
/recon
```

When both tools run on the same phone, the agent automatically discovers the
setup-generated `.local-access-code` from common local checkout locations:
`~/recon-anything`, `~/projects/recon-anything`, or
`~/.termux-code/repos/jaykk99/recon-anything`. In this case you can simply
run `/recon` and skip `/recon code`.

Alternatively supply `RECON_API_URL` and
`RECON_ACCESS_CODE` in the Termux shell; environment variables take precedence
over saved settings. Saved config and CLI history are owner-only, and
`/recon code` commands are excluded from the persisted CLI history.
Never paste the code into a chat prompt.

If the backend is on Linux at (for example) `192.168.1.30`, use
`/recon url http://192.168.1.30:8000`. It must be reachable from the
Android device via the local network; a service bound only to Linux's
localhost cannot be reached across devices. Plain HTTP is restricted to
loopback/private-network hosts; public deployments need HTTPS.

## Use naturally

```text
Scan my own staging.example.com for misconfigurations.
Do a passive recon check of the domains in my bug-bounty scope.
What did the latest ReconAnything scan find? Show high-severity findings.
```

The agent has these actions:
`health`, `plugins`, `start_scan`, `scan_status`, `findings`, and
`list_scans`. A scan needs explicit target ownership/authorization:
the model must call the tool with `authorized=true`, not assume permission.
Passive scanning is the default. To permit active scans, the person at the
Termux terminal must additionally type `/recon active on` for the current
session (it resets to off on restart). The tool also asks for scan approval
using the existing local approval callback.

Use `/recon off` to disable the connection, `/recon on` to re-enable,
and `/recon active off` to turn active scanning off without restarting.

## Troubleshooting

- `/recon` reports unavailable: start the scanner and check that port 8000 is
  accessible to the phone, or update the URL.
- HTTP 401: set the current access code with `/recon code ...`. If the backend
  uses a GitHub-cookie-only sign-in mode instead of the local access-code gate,
  use its local deployment or another supported authentication configuration.
- The model answers without a scan: ask it to use the `recon_anything` tool
  and check `/recon`. A text-only model may still fail to issue tool calls.
- The first Termux scanner installation is not guaranteed to work on every
  Android model: dependency builds, optional detection plugins and background
  battery restrictions may differ.

Automated tests use a stub backend. They check request/response contracts,
authorization, scan-mode gating and findings parsing, **not** a live scan on
your phone.

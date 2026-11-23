Live: https://termux-code.pages.dev

# termux-code

A coding agent that runs in Termux on Android, backed by the same 19-provider
pool error-inbox routes across — plus a direct line to your error-inbox agent
itself.

## Android device control (Termux:API)

The agent now offers a `device` tool with **21 Android actions** for battery,
Wi-Fi, cameras, sensors, clipboard, contacts, notifications, location, SMS
reading, flashlight, volume, speech, vibration and approved phone calls.
Run `/device` for installation diagnostics. Direct commands such as
`/device battery`, `/device location`, `/device torch on` and
`/device photo snapshot.jpg` also work when the selected language model
cannot issue tool calls. Sensitive actions require on-phone approval.

**Requires both** the compatible Termux:API Android app and
`pkg install termux-api`, plus the corresponding Android permissions.
This integration cannot grant root, bypass Android's app sandbox or control
arbitrary apps' private interfaces. See [Android device setup](docs/ANDROID-DEVICE.md).

## What this is, and what it isn't

This is **not** a fork of Anthropic's Claude Code. `anthropics/claude-code`
contains docs, plugins, examples and scripts — the CLI itself ships as a
closed-source npm package, so there's no source to port. This is a work-alike
written from scratch, shaped around what actually matters on a phone:

- **No dependencies in the CLI.** Nothing to compile on aarch64, nothing that
  dies halfway through `npm install` over mobile data.
- **Keys live in Vercel, not on the phone.** The CLI asks your deployment for
  completions. A lost phone doesn't take your provider keys with it.
- **Tools run locally.** Your code stays on the device. Only the snippets the
  model asks to read go over the wire.
- **Nothing happens without approval.** Every write, edit and shell command
  shows you what it wants to do first.

## ReconAnything security integration

The Termux agent has a native `recon_anything` tool for authorized security
reconnaissance and vulnerability assessments. When you ask it to assess a
site, scan a domain, or inspect findings, it can use the linked
[`recon-anything`](https://github.com/jaykk99/recon-anything) backend and return
the results inside the same chat. No additional AI provider or MCP server needed.

Start the ReconAnything backend first; then run `/recon` to check it.
On the same Android device, the default API URL and local setup-generated access
code are discovered automatically from common checkout locations. For a remote
Linux backend, configure `/recon url http://192.168.1.30:8000` and
`/recon code <access-code>`. The agent defaults to passive scans and
requires target authorization; active mode requires `/recon active on` in
each session.

See [setup, LAN configuration and troubleshooting](docs/RECON-ANYTHING.md).

## Two ways to talk to it

**`/model`** — pick a provider/model and it drives local tools: read, write,
edit, grep, bash, all sandboxed to the folder you launched from. This is the
"coding agent" mode.

**`/ask <message>`** — sends straight to your error-inbox agent instead, via
its real public endpoint (`POST /api/v1/message`). Same brain as its in-app
DM: its own tools, its own model routing, chief delegation included. It
**cannot** touch this phone's filesystem — that's a different, separate
agent running on error-inbox's own infrastructure. Use this when you want
error-inbox's actual agent, not a local coding session.

## Architecture

```
  Termux                          Vercel                    uncensored routes
┌─────────────┐            ┌──────────────────┐         ┌────────────────┐
│ termux-code  │ /model ──> │ /api/chat        │ ──────> │ Horde, Kilo    │
│  read/edit   │            │                  │         │ (no key), Bro, │
│  grep/bash   │ <─ tools ─ │ /api/models      │ <────── │ Venice, Naga,  │
│  (local fs)  │            │ /api/models/prefs│         │ OpenRouter, HF,│
│              │ /ask ────> │ /api/ask         │ ──────> │ DeepInfra, ... │
└──────────────┘            └────────┬─────────┘         └────────────────┘
                                      │
                                      ▼
                             error-inbox's own
                             /api/models + /api/v1/message
```

The phone runs the loop and the tools. Vercel holds the keys and the model
catalogue. `/api/models` merges the direct provider pool with error-inbox's
own live pool (with real recent success/fail counts); `/api/models/prefs`
pins or disables a model on error-inbox's *actual* rotation, the same call
its own settings page makes.

## Install on Termux

```sh
pkg install nodejs git
curl -fsSL https://termux-code.pages.dev/install.sh | bash
cd ~/projects/whatever
termux-code
```

The installer clones into `~/.termux-code/app`, drops a launcher on
`$PREFIX/bin`, and asks for your deployment URL. It never runs `npm install`.

To route the phone through Bro (your own uncensored gateway) instead of
the keyless chain, re-run the installer with the gateway's public URL —
`TERMUX_CODE_BRO_URL=https://<your-bro-url> curl -fsSL
https://termux-code.pages.dev/install.sh | bash` — or set it inside the
CLI with `/bro <url>` (and `/bro-code <code>` if the gateway ever
requires one). Bro is tried first whenever a URL is set; AI Horde stays
the fallback, and `/bro off` removes it. When the phone chats through
the deployment gateway instead of directly, the deployment itself needs
`BRO_BASE_URL` in its environment for Bro to appear in its catalogue.

## Deploy the gateway

```sh
git clone https://github.com/jaykk99/termux-code.git
cd termux-code
npm install
vercel --prod
```

Then set environment variables in the Vercel project. Names match
error-inbox's own `.env` exactly, so you can copy values straight across:

| Variable | Provider | Needs a key? |
| --- | --- | --- |
| — | Kilo | No — always on (models discovered live) |
| `LLM7_API_KEY` | LLM7 | Yes — free key; LLM7's only uncensored entry is key-gated |
| `AIHORDE_API_KEY` | AI Horde | No — anonymous key works, this just raises priority |
| `BRO_BASE_URL` (+ optional `BRO_ACCESS_CODE`) | Bro (your own gateway) | No code needed today — the gateway is unauthenticated; the code is sent as a Bearer token only when set. Off until `BRO_BASE_URL` is set; first in the chain once it is, Horde stays the fallback |
| `OPENROUTER_API_KEY` | OpenRouter | Yes |
| `DEEPINFRA_API_KEY` | DeepInfra | Yes — hosts Euryale L3.1 70B |
| `VENICE_API_KEY` | Venice | Yes — uncensored-first catalogue (`venice-uncensored-*`, abliterated Gemma/GLM/DeepSeek) |
| `NAGA_API_KEY` | Naga | Yes — independent host for Dolphin / Euryale / Magnum / Hermes / MythoMax |
| `HF_TOKEN` | Hugging Face | Yes |
| `HF_MODEL` | Hugging Face (EI catalog) | No — default-model override; only an uncensored-lineage id is accepted |
| `COMPOSIO_API_KEY` | Composio (agent app tools) | Yes |
| `GRATISFY_API_KEY` + `GRATISFY_BASE_URL` | Gratisfy | Yes (models discovered live) |
| `ERROR_INBOX_URL` | — | No, defaults to `error-inbox.onrender.com` |
| `ERROR_INBOX_KEY` | — | Only for `/ask` (an `eibx_...` token, minted on error-inbox's Settings page) |
| `NEXT_PUBLIC_SITE_URL` | — | Shown in the install command on the landing page |

Copy `.env.example` to `.env.local` for local development.

## The hosted app (owner-only)

The website is a gate, not a chatbot. Anonymous visitors get a GitHub
sign-in screen and nothing else; after sign-in the only page is the
Termux command page. The chat itself lives in Termux on the phone.

- **Sign-in.** GitHub OAuth (`/api/auth/github` → `/api/auth/callback`).
  Create one OAuth app in your GitHub settings with the callback
  `<your-site-url>/api/auth/callback`, then set `GITHUB_OAUTH_CLIENT_ID`,
  `GITHUB_OAUTH_CLIENT_SECRET` and `SESSION_SECRET`. Only
  `OWNER_GITHUB_LOGIN` (default `jaykk99`) is let in; any other GitHub
  account that completes sign-in is refused.
- **Command page.** `/` after sign-in shows the gateway token manager and
  the full Termux install command carrying the token, with a copy button.
  One active token, stored hashed, revocable there.
- **Hosted agent.** `/api/bot/chat` is an API endpoint (no web UI) behind
  the owner's session. The default model is the first uncensored pick
  from the owner's Inbox Models pool, served through error-inbox's
  Hugging Face catalog route (`HF_MODEL` overrides it, but only to another
  uncensored-lineage id), with the repo's failover chain behind it. Its tools run server-side and are
  session-only: `github_api` (GitHub as you, via the `GITHUB_TOKEN`
  server env), `composio_search` / `composio_execute` (your connected
  apps — Gmail, Calendar, Facebook, Outlook — through your Composio
  workspace, key in `COMPOSIO_API_KEY`), `run_terminal` (a sandboxed
  shell on the host — no provider keys in its environment), `fetch_url`
  and `web_search`. Every tool call is audit-logged to `.data/audit.log`.
- **MCP servers.** A workspace `.mcp.json` (Claude's file and key, so an
  existing config works unchanged) and/or `mcpServers` in
  `~/.termux-code/config.json` are connected at startup — each entry
  `{ "url": "https://…", "headers": { … } }`. Their tools appear to the model
  as `mcp__<server>__<tool>`, every call is approval-gated (a remote server is
  code this CLI cannot inspect), and a server that is down is named once and
  skipped instead of blocking the session. The small-model prompt lists at most
  eight MCP tools, with the rest as a count.
- **Sub-agents and project checks.** `task` spawns a sub-agent with a fresh
  context and its own step budget (research, read a repo, draft code) and
  returns only its report, so a side quest does not fill the main
  conversation; `run_tests` runs the project's own declared check (npm test,
  make test, pytest, cargo, go) after approval instead of guessing a command.
- **Frontier tools.** Eighteen more tools in `lib/frontier.mjs` — `glob`,
  `read_range`, `file_info`, `outline`, `repo_map`, `move_file`,
  `delete_file`, `make_dir`, `diff_files`, read-only `git`, `http_request`,
  `download_file`, `json_query`, `todo`, `remember`, `checkpoint`, `ports`
  and `sysinfo` — plus `/map` and `/undo` in the REPL: repo intelligence
  before reading, real rename/delete instead of shelling out, API calls and
  downloads, a durable task list and project memory, and one-command
  rollback of a risky change. All still bounded to the workspace, with the
  same approval gate on anything that touches your files.
- **Search and page reading on the phone itself.** `web_search` (DuckDuckGo
  HTML, no key) and `fetch_url` (page text with the markup stripped) are
  plain HTTP calls in `lib/web.mjs`, so they work in Termux with no Chromium,
  no gateway and no API key — the model can ground an answer in a real page
  instead of guessing. Verified live: asked for the latest Node.js LTS it
  searched, read the results and answered with the version.
- **Phone gateway.** The gateway routes (`/api/chat`, `/api/ask`,
  `/api/models`) accept the browser session OR a gateway token. Mint one
  on `/` after signing in and the page shows the full Termux install
  command carrying it. Already installed? `/gateway-token <token>`
  inside the CLI.
- **Deploy.** `Dockerfile` included (Koyeb/Render/Fly/any Docker host):
  `npm run build`, then `npm start`. Persistent `.data/` (token store +
  audit log) wants a volume on hosts with ephemeral disks.

## Where the model data actually comes from

`lib/models.mjs` registers uncensored-lineage models only — an aligned
model is not in the registry at all, so there is nothing aligned to fall
back to. Base URLs and auth styles match error-inbox's own `lib/llm.ts`,
pulled from source rather than guessed. Three sources merge in
`/api/models`:

1. **Direct pool.** The registered uncensored routes, gated on their env
   var names. A model only appears once its key is set — same as
   error-inbox's own `buildPool()`.
2. **Gratisfy live.** Discovered at request time from Gratisfy's own
   `/v1/models`, same as error-inbox does, so it never goes stale.
3. **Error Inbox live.** `GET {ERROR_INBOX_URL}/api/models` — the actual
   route backing error-inbox's own model switcher, including real recent
   success/fail counts and current pin/disable state.
4. **AI Horde workers.** Horde's own `status/models` feed, one entry per
   online uncensored worker (Qwen3.6-35B Heretic, gemma-4-31B Heretic,
   Rocinante-X-12B, L3-8B Stheno…), biggest first, deduplicated, with the
   pooled "any uncensored worker" pick kept at the end. Horde is the only
   keyless route, so on a phone with no keys this *is* the catalogue: it
   used to be a single nameless "any" row, and picking a worker here
   restricts the job to that worker (falling back to the rest of the
   uncensored set if it has gone offline — never to an any-worker job).

All three sources pass through one filter before anything is listed or
run: **uncensored models only**. Aligned models (GPT, Claude, Gemini and
the other RLHF flagships) never appear in `/api/models`, the phone's
picker, or the failover chain. The policy lives in one owner-editable
file, `lib/uncensored.mjs` — a curated provider pool (`hf`), id/label
markers for the uncensored lineages (Heretic, Dolphin, Stheno,
Rocinante, abliterated builds), and a short exact allowlist holding only
the AI Horde dispatcher (which fails rather than submit an any-worker job)
and the Bro gateway. A model a
provider rejects as unknown (BAD_MODEL) is blacklisted for the session
after the first rejection instead of being retried every turn, and
rate-limit retry-after hints pace the chain instead of being hammered
through.

## Request shapes, per provider

Every registered route is the OpenAI-compatible `chat/completions` shape
with a `Bearer` header (or no header at all, for Kilo), except the two below
it. The dispatcher also still carries three shapes with no registered
provider behind them, kept for parity with error-inbox:

- **Anthropic** — native `tool_use` blocks, full local tool support.
- **Gemini** — Google's own `systemInstruction`/`contents` shape. **Chat
  only** here: its function-calling schema differs enough from OpenAI's that
  wiring it without a live key to verify against risked shipping it wrong.
- **Cohere** — `v2/chat`, OpenAI-shaped messages but content returns as an
  array of parts. **Chat only**, and it registers no models: every Cohere
  model is aligned.
- **AI Horde** — an async submit-then-poll queue, volunteer-run and slow.
  Single-shot, no tools, last resort by design.

A model without tool support still answers in plain text — it just can't
read, write, or run anything on the phone for that turn. The settings page
and `/model` picker both flag these as "chat only, no file access." The
catalogue API reports the same honestly as `capabilities: { chat, tools }`
on every model.

## Adaptive reasoning (Termux CLI)

The CLI defaults to **adaptive** execution effort on each user turn. It uses a
local deterministic task classifier (no extra model call and no user prompts
sent to a classifier): simple questions use **fast**, routine edits use
**balanced**, and complex refactors/audits use **deep**. These modes change
how much planning and verification the agent is instructed to do, plus a
bounded tool-step budget (8/24/40) and retry budget for failing project
checks (1/2/3). Any file edits still go through the existing verification
mechanism. This improves the execution workflow; it does not increase a
model's underlying intelligence.

Inside the REPL use `/reasoning` to inspect the current setting or
`/reasoning fast|balanced|deep|adaptive` to choose and persist a setting.
For a one-shot run use `--reasoning=deep -p "refactor this module"`.
The explicit `--max-steps` remains an upper limit. Responses to unrelated
prompts do not accumulate reasoning instructions in saved sessions.

## Command line

The CLI takes flags, not just slash commands, so it also works from a
script or an agent:

```sh
termux-code                              # the REPL, as before
termux-code -p "add a test for parse()"  # one prompt, print the answer, exit
cat spec.md | termux-code                # the prompt can come from stdin
termux-code --help                       # usage
termux-code --version                    # version from package.json
```

| Flag | |
| --- | --- |
| `-p`, `--print <text>` | One-shot: run this prompt, print the answer, exit. A bare first argument is treated the same way |
| `-y`, `--yes` | Kept for compatibility; every tool call is already approved |
| `--ask` | Ask before writes and shell commands (the old confirmation prompt) |
| `--verbose` | Show every provider the failover chain tried and why it failed |
| `-m`, `--model <id>` | Start on this model, by id or label substring; a typo fails with exit 2 |
| `-C`, `--cwd <dir>` | Workspace root (default: the current directory) |
| `-n`, `--max-steps <n>` | Tool steps per turn (default 40, or 120 with `--deep`) |
| `--deep` | Deep work: explicit acceptance criteria, a todo ledger, 120 tool steps, and it carries on past the budget instead of stopping half done (also `/deep`) |
| `--session <id>` | One-shot into an existing session and save it |
| `--json` | One-shot: a single JSON object on stdout (`{ok, answer, model, provider, source, steps, savedSession}`), traces diverted to stderr |

Exit codes: `0` an answer came back, `1` the turn failed (every provider
failed, or the failover chain was exhausted), `2` bad usage.

**Nothing asks permission.** Tool calls run: writes, shell commands, all
of it. There is no `allow? [y/N]` after every command, in the REPL or in a
one-shot run, because a confirmation dialog between you and your own phone
is not a safety feature. If you ever want the older guard back for one
run, pass `--ask`; without a terminal that mode reads only.

**It answers like an engineer, not a help desk.** The system prompt asks for
first-person, direct answers — no preamble, no disclaimers, no moralising —
and replies are rendered as Markdown on the way to the screen: bold, inline
code, fenced code kept exactly as written, bullets sized to the phone's
columns, instead of one flattened wall of text. The spinner names who is
taking the turn (`Thinking · horde/any 12s`), and a reply that comes back
empty says so instead of leaving a blank line.

**Quiet by default.** A turn that walks several dead providers reports one
line (`[chain] 3 providers failed, answered by horde/...`) instead of a
wall of failures, and the full per-provider detail is behind `--verbose`
or `/verbose`.

One-shot runs are ephemeral: nothing lands in `~/.termux-code/sessions`
unless `--session` names a saved one, so a script that runs fifty prompts
does not bury the conversation you were actually in.

## Commands

| Command | |
| --- | --- |
| `/model` | Pick a model for local read/edit/bash work |
| `/models` | Show what's available, grouped by source |
| `/think` | Toggle plan-first: write a 5-step `TODO.md`, then work it in order (also `--think`) |
| `/deep` | Toggle deep work: acceptance criteria, a todo ledger, 120 tool steps, and automatic continuation past the budget (also `--deep`) |
| `/keys` | Show which provider keys are set |
| `/key NAME value` | Save a provider key (`VENICE_API_KEY`, `OPENROUTER_API_KEY`, …) and switch its provider on |
| `/trace` | Print the model's own text for every step — the closest a text worker gets to a visible train of thought |
| `/ask <message>` | Message your error-inbox agent instead (no file access) |
| `/inbox-key <token>` | Save the `eibx_...` token `/ask` uses |
| `/gateway <url>` | Point at a different deployment |
| `/bro <url>` | Point Bro at your gateway (tunnel URL or Render URL); `/bro off` stops using it |
| `/bro-code <code>` | Save the Bro access code (never printed back) |
| `/sessions` | List saved conversation sessions |
| `/session <n>` | Resume a session by number or id |
| `/new` | Start a new session |
| `/rename <title>` | Rename the current session |
| `/export [file]` | Export the session as Markdown |
| `/failover` | Show provider failover status |
| `/verify [on\|off\|<cmd>]` | Auto-check changes with the project's tests (default: on, detected) |
| `/compact` | Summarize older context now |
| `/context` | Show how much context the session uses |
| `/clear` | Forget the conversation, keep the session |
| `/map` | Print the project map: languages, manifests, entry points, scripts, directories |
| `/undo [id]` | Restore the newest checkpoint, or the one named |
| `/cwd` | Show the workspace root |
| `/exit` | Quit |

## Provider failover

Local completions (no gateway) walk a failover chain instead of dying on the
first 429 or hang: your chosen model first, then the rest of the catalogue in
failover order — keyless tool-capable providers first, then keyed ones, then
chat-only models last. Every failed attempt prints one line with the provider,
latency and error, and if the whole chain fails you get the full attempt log
instead of a generic error.

The chain is uncensored-only end to end. There is no last-resort rung: a
saved `/model` choice is honoured only while it is still uncensored, and the
fresh-session pick goes Horde, then an uncensored tool-capable route, then any
uncensored route — never `models[0]`, so an aligned model that reached the
catalogue by some other path still cannot take the seat.

A refusal is never the answer. A refusal counts as a failed attempt and the
chain walks on; when every uncensored route declines, the turn ends with a
plain "refused by every uncensored route" error that says nothing was
answered, and the refusal text stays in the attempts log behind `/verbose`
rather than being echoed as termux-code's own words.

An uncensored route that still declines gets one nudge in the same turn —
`[policy] … no refusal, no apology, no disclaimer, no lecture` — before the
chain moves on. One retry per route, never a loop: a refusal from this pool is
nearly always a model answering a filter it does not have. The same nudge also
fires on an **empty generation**, which is how the volunteer workers actually
duck an edgy prompt (measured live: a keylogger-for-my-own-laptop prompt and a
crack-my-own-zip prompt both came back blank rather than refused). And a
generation that repeats its own instructions in a loop is treated as collapsed
and resubmitted, instead of being shown as an answer.

The Horde tool brief is always sent, whatever the prompt looks like. Gating it
on what the prompt looked like (path? shell verb?) meant "search the web for
X" went out with no `bash` or `browser` tool to call, and the agent answered
that it could not search — so the gate is gone. Two things keep the small
workers usable instead:

- The output-format rule lives in the **system block**, ahead of the ask. Put
  after the ask, it was the instruction a worker answered: told to run
  `echo hi`, it replied "Understood. I will adhere to the new format from now
  on." (live 2026-11-23). Prose instead of a tool call is recoverable (the
  turn asks for a resend); an acknowledgement is a dead turn.
- A reply that is only a plan — "I'll write the script and save it to your
  home directory.", under 400 chars, no code, no tool call — gets one more ask
  with no tool list, which is where these workers do answer, and that answer
  is used when it is substantive.

Speed comes from the same places. Horde's worker feed is a ~4 KB JSON list that
used to be fetched before every completion (measured here: 210–354 ms per
fetch), so a non-empty answer is now cached for 90 seconds; the queue is polled
every 1.2 s instead of every 3 s. And a tool call a text-protocol model wrote
as a bare object buried in prose is reported back to it, so the turn asks for
the `<tool_call>` block (up to twice) instead of ending as if nothing was
asked — the "answered without a tool call" flake.

A per-process circuit breaker backs it: three consecutive failures cool a
provider down for ten minutes, then it becomes eligible again automatically.
`/failover` shows which providers are cooling down and why.

## Sessions

Conversations persist as JSONL under `~/.termux-code/sessions/`. A launch
starts a **fresh** conversation: continuing an old one is explicit, with
`--resume` (`-r`, newest saved session) or `/sessions` + `/session <n>`.
Resuming automatically on every start meant a new prompt was appended to the
previous task, so the agent kept working on that one instead of the one just
asked — the "stuck on previous tasks" report. A fresh launch saves nothing
until its first turn, so `/sessions` lists only conversations that happened.
`/rename` titles, `/export` writes a Markdown transcript. The live context compacts automatically past ~60k characters or
80 messages: older turns are replaced by one summary — a deterministic digest
(every request, files read and changed, commands and their exit codes) plus a
model-written summary when the model answers in time — and the recent turns
stay verbatim. `/compact` does it on demand, `/context` shows the size. Command history also persists
across restarts (`~/.termux-code/history`, last 200 commands).

## Frontier tools

Twenty additions on top of the original read/write/edit/grep/bash set. Every
one is a plain Node module: no dependency, no native build, and every path
resolves inside the directory you launched from.

**Understand a repo before touching it.** `repo_map` gives the file count,
languages, package manager, manifests, entry points, scripts and busiest
directories in one call. `glob` finds files by pattern (`**/*.{js,ts}`);
`outline` lists a file's functions, classes and types with line numbers
(JS/TS, Python, Rust, Go, shell, Ruby); `read_range` reads a window of a big
file instead of the whole thing; `file_info` reports size, line count,
language, mode, mtime and sha256 without reading it into the conversation.

**Change files safely.** `move_file` renames across folders (creating
parents, refusing to overwrite), `delete_file` removes a file or, with
`recursive: true`, a directory, and `make_dir` creates a path. All three ask
first. `diff_files` shows a unified diff between two files, or against
`HEAD` when the second is omitted, so the model can check its own edit.
`git` covers the read-only half of git (status, log, diff, show, branch,
ls-files, blame, describe, shortlog, tag list); commit/push/reset/checkout
stay in `bash`, where they belong.

**Reach the outside.** `http_request` calls an API with headers, a raw body
or a JSON body and pretty-prints the reply (non-GET needs approval, 20s
timeout); `download_file` saves a URL into the workspace with a size cap and
sha256; `json_query` pulls one value out of a `.json` file by path
(`scripts.test`, `items[0].name`) without loading it all.

**Keep the thread.** `todo` stores a structured task list under
`.termux-code/todo.json` (read/write/add/done/clear), so a multi-step job has
a plan the model can see; `remember` appends a durable fact or preference to
`.termux-code/memory.md`, which is injected into the system prompt at the
start of every later session in that project.

**Undo a mistake.** `checkpoint` snapshots up to 300 files (8 MB) under
`.termux-code/checkpoints`; `list` shows them and `restore` puts them back
(approval-gated). `/undo` does the restore from the REPL and `/map` prints
the repo map without spending a model turn.

**See the machine.** `ports` reads listening TCP sockets from `/proc` (with
a single-port check) so you can tell whether a dev server actually came up;
`sysinfo` reports OS, arch, Node version, CPUs, load, memory, uptime, shell,
Termux detection and free disk.

All of it lives under `.termux-code/` for the stateful pieces, which is
gitignored so a snapshot never lands in your repository.

## Tests

`npm test` runs the `node:test` battery in `tests/` (862 tests): gateway HTTP
helpers, the model registry and its trusted resolution, the failover chain and
circuit breaker, session persistence, the CLI argument parser, and an
end-to-end one-shot run against a stub gateway — including the check that an
unattended run declines a shell command and tells the model so. The
uncovered core modules have suites too: context compaction, plan-and-verify,
the text tool-calling protocol, the MCP client, unified-diff patching, the
TUI primitives, gateway-tool dispatch, the audit log, the token store, and
the frontier tools (globbing, outlining, repo map, diffs, git, HTTP,
downloads, JSON paths, todo, memory, checkpoints, ports and sysinfo).

Those suites stub `fetch`, so they cannot catch a route that answers with a
refusal or a tool call its wire format drops. `npm run test:live` does: it
clones a real GitHub checkout into a temp dir, runs code there with the real
tool runner, then asks every runnable uncensored route to run a shell command
and write a file in that checkout, executing each tool call the model returns.
A route that errors, refuses, answers without a tool call, or runs a command
without writing the file retries once on a fresh job and a fresh token before
it counts as a failure, since volunteer workers rotate and a cold one reads
like a broken route; `--no-retry` makes a single attempt count. It reads keys from `.env`, and reports no runnable route
(exit 2) when none is gated on:

```sh
npm run test:live                              # every runnable uncensored route
node scripts/live-smoke.mjs --route horde/any  # just one
node scripts/live-smoke.mjs --json --keep      # machine-readable, keep the checkout
node scripts/live-smoke.mjs --no-retry         # one attempt per route, no retry
```

### Use your own repo for a task

The clone is a real workspace, not only a smoke target: `--task` runs your
instruction in it instead of the smoke proof, with the real tool runner writing
the changes, and `--push` commits what the model actually changed onto a new
`live/<route>-<token>` branch and pushes that branch to the repo, so you review
the diff before it goes anywhere near `main`. `--push` needs `GITHUB_TOKEN` —
the same one the clone uses, passed through git's `GIT_CONFIG_*` environment,
never argv.

```sh
node scripts/live-smoke.mjs --repo you/thing --route horde/any \
  --task "add a --dry-run flag to bin/thing.mjs and document it in README.md"

node scripts/live-smoke.mjs --repo you/thing --route horde/any \
  --task "add a --dry-run flag to bin/thing.mjs" --push
```

A task counts as passed only when the model called a tool **and** `git status`
shows the checkout changed: talking about the change is `no-tool`, reading
files and stopping is `no-write`, declining is `refusal`. One route runs per
task (the `--route` you name, else the first runnable one) so the diff and the
branch belong to the model that made them, and a retry resets the checkout
first so attempt one's half-written files cannot make attempt two look like it
wrote. Exit `0` means the task landed, `1` a route, the checkout, a push or the
flags failed, `2` nothing runnable.

## Tools the local agent has

`list_dir`, `read_file`, `grep` run without asking. `write_file`, `edit_file`,
`multi_edit`, `apply_patch` and `bash` show you the change and wait for `y`.

- `multi_edit` — several exact-string edits to one file, all-or-nothing, one approval.
- `apply_patch` — a unified diff across files (create, modify, delete). Hunks
  are located by their context lines, so wrong line numbers still apply.
- After every write the file is re-read: the tool result shows the lines now
  on disk, plus a syntax check for `.js/.mjs/.cjs`, `.json`, `.py` and `.sh`.

`browser` drives the phone's own Chromium (`pkg install chromium`): `open`,
`read`, `screenshot` and `scroll` run without asking, `click` and `type`
wait for `y` like a write. It talks to Chromium over the DevTools protocol
and keeps one live session per CLI run; when CDP is unavailable it falls
back to one-shot headless reads/screenshots, and when Chromium is not
installed at all, `open`/`read` fall back to a gateway fetch (`/api/browser/read`)
while the rest report the install line.

Every path is resolved against the directory you launched from and rejected
if it escapes it. The agent cannot touch `~/.ssh` from inside `~/projects/app`.

### Models without native tool calling

Gemini, Cohere, Horde and HF, plus any OpenAI-shaped endpoint that rejects
the `tools` field, drive the same tools through a text protocol
(`lib/text-tools.mjs`): the model writes
`<tool_call>{"name": "...", "args": {...}}</tool_call>` and gets
`<tool_result>` blocks back. A call written as a bare
`{"name": "...", "args": {...}}` object with no wrapper is taken too, when
the name is a real tool — small workers drop the tags even when the example
is right in front of them, and those calls used to be thrown away. These models also now see the whole
conversation, tool results included, not just the last message.
Through a gateway they get your connected apps too: `composio_search` and
`composio_execute` are described in the same protocol and run server-side,
with the same approval prompt as a native call.

### Plan and verify

For multi-step work the agent opens with a short plan. When it finishes
changing files, the CLI runs the project's own check (`npm test`, else an
npm typecheck/check/lint/build script, `make test`, pytest, `cargo test`,
`go test`) — asking once per session first. A failure goes back to the model
with the tail of the log; it gets three attempts before the CLI stops and
hands it to you. `/verify off` turns it off, `/verify <cmd>` sets the command.

## Known limits

- Shell commands time out at 60 seconds (the verify step gets 180).
- The loop stops after 40 tool steps (120 with `--deep`). A turn that is still using tools at the budget gets two automatic continuations before it stops; say "continue" to resume after that.
- Files over 120 KB won't be read whole — ask the agent to grep instead.
- Text-protocol tool calling is less reliable than native calling, especially
  on small models.
- AI Horde is a volunteer queue — expect it to be slow, and don't rely on it
  for anything time-sensitive.
- Vercel functions cap at 60 seconds for `/api/chat`; slow models can time
  out mid-turn. `/api/ask` gets 280 seconds, matching error-inbox's own
  `/api/v1/message` route.

## Licence

MIT.

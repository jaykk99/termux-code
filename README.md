# termux-code

A coding agent that runs in Termux on Android, backed by the same 19-provider
pool error-inbox routes across — plus a direct line to your error-inbox agent
itself.

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
  Termux                          Vercel                      19 providers
┌─────────────┐            ┌──────────────────┐         ┌────────────────┐
│ termux-code  │ /model ──> │ /api/chat        │ ──────> │ Kilo, LLM7,    │
│  read/edit   │            │                  │         │ Horde (no key) │
│  grep/bash   │ <─ tools ─ │ /api/models      │ <────── │ Groq, Gemini,  │
│  (local fs)  │            │ /api/models/prefs│         │ NVIDIA, Cohere,│
│              │ /ask ────> │ /api/ask         │ ──────> │ Cerebras, ...  │
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
curl -fsSL https://<your-deployment>.vercel.app/install.sh | bash
cd ~/projects/whatever
termux-code
```

The installer clones into `~/.termux-code/app`, drops a launcher on
`$PREFIX/bin`, and asks for your deployment URL. It never runs `npm install`.

## Deploy the gateway

```sh
git clone https://github.com/<you>/termux-code.git
cd termux-code
npm install
vercel --prod
```

Then set environment variables in the Vercel project. Names match
error-inbox's own `.env` exactly, so you can copy values straight across:

| Variable | Provider | Needs a key? |
| --- | --- | --- |
| — | Kilo | No — always on |
| — | LLM7 | No — always on |
| `AIHORDE_API_KEY` | AI Horde | No — anonymous key works, this just raises priority |
| `GROQ_API_KEY` | Groq | Yes |
| `GEMINI_API_KEY` | Gemini | Yes (chat only — see below) |
| `OPENROUTER_API_KEY` | OpenRouter | Yes |
| `NVIDIA_API_KEY` | NVIDIA NIM | Yes |
| `COHERE_API_KEY` | Cohere | Yes (chat only; currently empty — see below) |
| `CEREBRAS_API_KEY` | Cerebras | Yes |
| `SAMBANOVA_API_KEY` | SambaNova | Yes |
| `GITHUB_MODELS_TOKEN` | GitHub Models | Yes (PAT with models permission) |
| `MISTRAL_API_KEY` | Mistral | Yes |
| `TOGETHER_API_KEY` | Together AI | Yes |
| `FIREWORKS_API_KEY` | Fireworks | Yes |
| `DEEPINFRA_API_KEY` | DeepInfra | Yes |
| `HF_TOKEN` | Hugging Face | Yes |
| `GRATISFY_API_KEY` + `GRATISFY_BASE_URL` | Gratisfy | Yes (models discovered live) |
| `OMNIROUTE_API_KEY` + `OMNIROUTE_BASE_URL` | OmniRoute (self-hosted) | Yes, both |
| `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL` | Anthropic | Yes |
| `ERROR_INBOX_URL` | — | No, defaults to `error-inbox.vercel.app` |
| `ERROR_INBOX_KEY` | — | Only for `/ask` (an `eibx_...` token, minted on error-inbox's Settings page) |
| `NEXT_PUBLIC_SITE_URL` | — | Shown in the install command on the landing page |

Copy `.env.example` to `.env.local` for local development.

## Where the model data actually comes from

`lib/models.mjs` is built from error-inbox's own `lib/llm.ts`, pulled from
source rather than guessed — the exact base URLs, auth styles, and model IDs
it uses today. Three sources merge in `/api/models`:

1. **Direct pool.** Every provider error-inbox itself knows how to call,
   gated on the same env var names. A model only appears once its key is
   set — same as error-inbox's own `buildPool()`.
2. **Gratisfy live.** Discovered at request time from Gratisfy's own
   `/v1/models`, same as error-inbox does, so it never goes stale.
3. **Error Inbox live.** `GET {ERROR_INBOX_URL}/api/models` — the actual
   route backing error-inbox's own model switcher, including real recent
   success/fail counts and current pin/disable state.

## Request shapes, per provider

Most of the 19 are one OpenAI-compatible `chat/completions` shape with a
`Bearer` header (or no header at all, for Kilo and LLM7). Four diverge, and
each is handled to match:

- **Anthropic** — native `tool_use` blocks, full local tool support.
- **Gemini** — Google's own `systemInstruction`/`contents` shape. **Chat
  only** here: its function-calling schema differs enough from OpenAI's that
  wiring it without a live key to verify against risked shipping it wrong.
- **Cohere** — `v2/chat`, OpenAI-shaped messages but content returns as an
  array of parts. **Chat only**, and currently contributes zero models
  anyway — error-inbox's own pool excludes Cohere right now (both
  command-a models read 0% on its live health page).
- **AI Horde** — an async submit-then-poll queue, volunteer-run and slow.
  Single-shot, no tools, last resort by design.

A model without tool support still answers in plain text — it just can't
read, write, or run anything on the phone for that turn. The settings page
and `/model` picker both flag these as "chat only, no file access." The
catalogue API reports the same honestly as `capabilities: { chat, tools }`
on every model.

## Web console

`/console` talks to the gateway exactly the way the Termux CLI does — pick
a model, send one message, read the reply with code blocks highlighted. It
keeps a per-device request history (model, timing, prompt/reply previews).
Useful for checking a model answers before you commit a whole coding
session to it, and it works fine from a phone browser.

## Commands

| Command | |
| --- | --- |
| `/model` | Pick a model for local read/edit/bash work |
| `/models` | Show what's available, grouped by source |
| `/ask <message>` | Message your error-inbox agent instead (no file access) |
| `/inbox-key <token>` | Save the `eibx_...` token `/ask` uses |
| `/gateway <url>` | Point at a different deployment |
| `/clear` | Forget the conversation, keep the session |
| `/cwd` | Show the workspace root |
| `/exit` | Quit |

## Tools the local agent has

`list_dir`, `read_file`, `grep` run without asking. `write_file`, `edit_file`
and `bash` show you the change and wait for `y`.

Every path is resolved against the directory you launched from and rejected
if it escapes it. The agent cannot touch `~/.ssh` from inside `~/projects/app`.

## Known limits

- Shell commands time out at 60 seconds; long builds need a separate pane.
- The loop stops after 24 tool steps. Say "continue" to resume.
- Files over 120 KB won't be read whole — ask the agent to grep instead.
- Gemini and Cohere are chat-only (see above).
- AI Horde is a volunteer queue — expect it to be slow, and don't rely on it
  for anything time-sensitive.
- Vercel functions cap at 60 seconds for `/api/chat`; slow models can time
  out mid-turn. `/api/ask` gets 280 seconds, matching error-inbox's own
  `/api/v1/message` route.

## Licence

MIT.

# Deploying to Cloudflare Pages

Live at https://termux-code.pages.dev (Cloudflare Pages project `termux-code`).

This app builds with the OpenNext Cloudflare adapter and deploys as a Pages
"advanced mode" `_worker.js` bundle plus static files:

```bash
npm install
npm run build:cf          # produces .open-next/

# stage the Pages deploy directory
rm -rf /tmp/tc-pages && mkdir /tmp/tc-pages
cp -r .open-next/. /tmp/tc-pages/
cp /tmp/tc-pages/worker.js /tmp/tc-pages/_worker.js
cp -r /tmp/tc-pages/assets/. /tmp/tc-pages/   # static files live at the root
rm -rf /tmp/tc-pages/assets /tmp/tc-pages/cache /tmp/tc-pages/cloudflare-templates

npx wrangler pages deploy /tmp/tc-pages --project-name termux-code --branch main
```

`public/_routes.json` rides along in the staged output: it keeps
`/_next/static/*` and `/install.sh` out of the worker so Pages serves those
files directly (the OpenNext worker cannot serve them itself on Pages).

Project settings (Cloudflare API / dashboard, not wrangler):

- Production compatibility: date `2025-10-01`, flag `nodejs_compat`.
- Production env vars: `HF_MODEL` (the hosted agent's default model — the
  first uncensored entry in Jay's Inbox Models pool, served via the `hf`
  provider), `COMPOSIO_API_KEY` (secret; the agent's Composio tools —
  unset until a working key is pasted, the stored one returns 401),
  `OWNER_GITHUB_LOGIN`, `SESSION_SECRET` (secret), and — once the GitHub
  OAuth app exists — `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`
  (secret), `GITHUB_TOKEN` (secret). The OAuth callback is
  `https://termux-code.pages.dev/api/auth/callback`.
- Gateway token store (REQUIRED for the Mint button to work — without it,
  minting answers a JSON 500 naming the missing binding instead of
  minting): a KV namespace bound to the Pages project as `GATEWAY_KV`.
  KV is free (Workers free tier). Dashboard path: Workers & Pages → KV →
  Create namespace (e.g. `termux-code-gateway`), then Pages project
  `termux-code` → Settings → Functions → KV namespace bindings → Add
  binding, variable name `GATEWAY_KV`, namespace `termux-code-gateway`.
  Any later deployment picks the binding up automatically; no code or
  env-var change is needed per deploy. Note the existing API token's
  scopes (Pages Edit, Zone DNS Edit, Zone Read) do not cover Workers KV,
  so the namespace + binding are a dashboard step (or a token with
  Workers KV Storage Edit), not a wrangler step.

Git-built deployments and error 1101 — read this before debugging app code:

- `nodejs_compat` is REQUIRED, not optional. Every route declares
  `runtime = 'nodejs'`, and the OpenNext adapter itself imports Node
  modules (`node:async_hooks`, `node:buffer`, `node:stream/web`,
  `node:process`). A deployment that runs the worker without that flag
  throws at worker startup, so EVERY route answers Cloudflare error
  1101 ("Worker threw exception") — root, auth, and chat alike.
- Incident 2026-10-24: every Git-built deployment since PR #6 built
  "success" but 1101'd on all routes, while the manual deploy of PR #5
  (d4bde2cc) kept working. The code delta between those builds
  (041d9d1..b3e3e66) contained no startup-relevant change — no new
  static imports, no dependency changes, comment-only adapter config —
  so the cause is deployment configuration, not app code. If a
  Git-built deployment 1101s again, check FIRST, in the dashboard:
  Pages project `termux-code` → Settings → Functions → Compatibility
  Flags for that deployment (must include `nodejs_compat`), and the
  Git build settings (build command `npm run build:cf`, producing
  `.open-next/`). Roll back to the last working deployment if it is
  still broken after that check.
- Hardening in the repo (same incident): the shared auth module
  (`lib/auth.mjs`, imported by the root page and every auth/chat route)
  no longer statically imports `node:fs`/`node:path`; the filesystem
  token store lives in `lib/token-store-fs.mjs` and loads via dynamic
  import, only on the Node/tests branch. The KV branch (the Cloudflare
  path) never touches it. `node:crypto` stays static — sessions are
  synchronous and WebCrypto is async-only — so `nodejs_compat` is
  still required regardless of this change.

Known runtime differences on Cloudflare:

- `run_terminal` returns an explicit "unavailable on this runtime" message:
  Workers/Pages has no shell. It works in the Docker deployment.
- Skills are read from the filesystem on Node; on Cloudflare the skills
  directory is not readable, so `list_skills` returns none there.
- Gateway tokens: the Node/Docker deployment keeps them in `.data/`; on
  Cloudflare they live in the `GATEWAY_KV` namespace (hashed, one active
  token per owner, same as the file store). Sign-in sessions are signed
  cookies and work on both runtimes.

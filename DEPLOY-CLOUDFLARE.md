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
- Gateway token store (OPTIONAL now — minting no longer needs it, since
  tokens are stateless and signed; see lib/auth.mjs): a KV namespace
  bound to the Pages project as `GATEWAY_KV` only matters for legacy
  store-backed tokens. KV is free (Workers free tier). Dashboard path:
  Workers & Pages → KV → Create namespace (e.g. `termux-code-gateway`),
  then Pages project `termux-code` → Settings → Functions → KV namespace
  bindings → Add binding, variable name `GATEWAY_KV`, namespace
  `termux-code-gateway`. Any later deployment picks the binding up
  automatically; no code or env-var change is needed per deploy. Note the
  existing API token's scopes (Pages Edit, Zone DNS Edit, Zone Read) do
  not cover Workers KV, so the namespace + binding are a dashboard step
  (or a token with Workers KV Storage Edit), not a wrangler step. To
  revoke all stateless tokens at once, rotate `GATEWAY_TOKEN_SECRET`
  (or `SESSION_SECRET`, which the tokens fall back to).

Known runtime differences on Cloudflare:

- `run_terminal` returns an explicit "unavailable on this runtime" message:
  Workers/Pages has no shell. It works in the Docker deployment.
- Skills are read from the filesystem on Node; on Cloudflare the skills
  directory is not readable, so `list_skills` returns none there.
- Gateway tokens: stateless and signed (HMAC-SHA256, 365-day expiry), so
  they verify identically on every runtime — no store needed. The
  Node/Docker deployment and a bound `GATEWAY_KV` namespace only matter
  for legacy store-backed tokens now. Sign-in sessions are signed
  cookies and work on both runtimes.

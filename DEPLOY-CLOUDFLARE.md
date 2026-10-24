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

Known runtime differences on Cloudflare:

- `run_terminal` returns an explicit "unavailable on this runtime" message:
  Workers/Pages has no shell. It works in the Docker deployment.
- Skills are read from the filesystem on Node; on Cloudflare the skills
  directory is not readable, so `list_skills` returns none there.
- Gateway tokens and sessions state that the Node deployment keeps in
  `.data/` has no filesystem on Cloudflare; sign-in sessions are signed
  cookies and work, token minting/storage does not persist there.

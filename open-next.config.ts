import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Minimal Cloudflare config: no R2/KV/D1 overrides in code. The gateway
// token store's KV namespace is a project-level binding (variable
// GATEWAY_KV, see DEPLOY-CLOUDFLARE.md), read at request time via
// getCloudflareContext() — nothing to override here. The app's pages are
// force-dynamic and its state lives in signed cookies, so the default
// in-memory incremental cache is enough for this deployment.
export default defineCloudflareConfig({});

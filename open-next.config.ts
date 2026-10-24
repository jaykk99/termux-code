import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Minimal Cloudflare config: no R2/KV/D1 overrides. The app's pages are
// force-dynamic and its state lives in signed cookies, so the default
// in-memory incremental cache is enough for this deployment.
export default defineCloudflareConfig({});

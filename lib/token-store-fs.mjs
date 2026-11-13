/**
 * Filesystem gateway-token store — Node and tests ONLY.
 *
 * This module is deliberately separate from lib/auth.mjs and is loaded
 * from there via dynamic import, only on the filesystem branch. The
 * Cloudflare Pages worker has no filesystem and uses the KV branch
 * instead, so the worker must never evaluate node:fs/node:path at
 * startup: a static import of either in the shared auth module would
 * put a Node-only import into every route's bundle (the root page and
 * every auth/chat route import lib/auth.mjs). Keeping this module
 * dynamically loaded keeps that import out of the worker's startup
 * path entirely, while Node and the test suite keep the exact same
 * JSON-file behaviour.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Default file location: <cwd>/.data/gateway-tokens.json. */
export function defaultStorePath() {
  return path.join(process.cwd(), '.data', 'gateway-tokens.json');
}

/** Read the token document; an unreadable store reads as empty. */
export async function fsReadStore(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(data.tokens) ? data : { tokens: [] };
  } catch {
    return { tokens: [] };
  }
}

/** Write the token document, creating parent directories as needed. */
export async function fsWriteStore(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

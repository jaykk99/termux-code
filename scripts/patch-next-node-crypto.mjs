// Patches the installed Next.js server so it can boot on Cloudflare Workers.
//
// Problem: Next's server (next/dist/server/node-environment.js) requires
// node-environment-extensions/node-crypto at boot, and that extension
// unconditionally calls require('node:crypto') whenever NEXT_RUNTIME is
// not 'edge'. The OpenNext adapter bundles the server for Workers, and
// the production bundle ends up with a require of node:crypto that has
// no working `require` to fall back to, so the worker throws
// `Dynamic require of "node:crypto" is not supported` before any route
// runs (Cloudflare error 1101 on every route).
//
// Fix: before the adapter bundles, overwrite the extension files with
// the empty shim in lib/node-crypto-shim.js. The extension only patches
// node:crypto's random functions for `experimental.cacheComponents`
// prerenders, which this app does not use, so the empty module is
// behavior-preserving here (see the shim's header).
//
// Safety: the patch is asserted, not blind. Each target file must either
// already contain the shim marker (idempotent re-run) or contain the
// expected unguarded require of node:crypto. Anything else throws and
// fails the build loudly, so a future Next.js upgrade that moves or
// rewrites the extension can never silently reintroduce the 1101.
//
// Runs as part of `npm run build:cf`. It only touches files under
// node_modules, which the Pages build reinstalls from the lockfile, so
// it never changes committed source. Plain `next build` / `next dev`
// do not run it.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SHIM_MARKER = 'termux-node-crypto-shim';
const REQUIRE_MARKER = /require\(['"]node:crypto['"]\)/;

const TARGETS = [
  'next/dist/server/node-environment-extensions/node-crypto.js',
  'next/dist/esm/server/node-environment-extensions/node-crypto.js',
];

// Overwrites one extension file with the shim. Returns 'patched',
// 'already-patched', or throws on unexpected content.
export function patchFile(targetPath, shimContent) {
  if (!existsSync(targetPath)) {
    throw new Error(`expected Next.js extension file not found: ${targetPath}`);
  }
  const current = readFileSync(targetPath, 'utf8');
  if (current.includes(SHIM_MARKER)) return 'already-patched';
  if (!REQUIRE_MARKER.test(current)) {
    throw new Error(
      `refusing to patch ${targetPath}: it does not contain the expected ` +
        `unguarded require('node:crypto') — Next.js may have changed the ` +
        `extension; update this script instead of shipping a broken worker`
    );
  }
  writeFileSync(targetPath, shimContent);
  return 'patched';
}

export function main(repoRoot = process.cwd()) {
  const shimPath = path.join(repoRoot, 'lib', 'node-crypto-shim.js');
  if (!existsSync(shimPath)) {
    throw new Error(`shim file not found: ${shimPath}`);
  }
  const shim = readFileSync(shimPath, 'utf8');
  if (!shim.includes(SHIM_MARKER)) {
    throw new Error(`shim file is missing its marker: ${shimPath}`);
  }
  const results = [];
  for (const target of TARGETS) {
    const targetPath = path.join(repoRoot, 'node_modules', target);
    results.push(`${target}: ${patchFile(targetPath, shim)}`);
  }
  for (const line of results) console.log(`patch-next-node-crypto: ${line}`);
  return results;
}

const invokedAsScript =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  main(path.join(scriptDir, '..'));
}

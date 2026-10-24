// Empty stand-in for Next.js's node-environment-extensions/node-crypto.
//
// Marker: termux-node-crypto-shim (checked by scripts/patch-next-node-crypto.mjs).
//
// Next's server (next/dist/server/node-environment.js) unconditionally
// requires that extension at boot, and the extension unconditionally
// calls require('node:crypto') whenever NEXT_RUNTIME is not 'edge'.
// In the Cloudflare Workers bundle that require has no working `require`
// to fall back to, so the worker throws
// `Dynamic require of "node:crypto" is not supported` before any route
// runs (Cloudflare error 1101 on every route).
//
// The extension only patches node:crypto's random functions so that
// `experimental.cacheComponents` prerenders can track random-byte reads.
// This app does not use cacheComponents, and the app's own crypto use
// (createHash, randomBytes for tokens) is not patched by the extension,
// so loading an empty module is behavior-preserving here: the random
// functions simply keep their native, unpatched behavior.
//
// This file is the canonical shim content. scripts/patch-next-node-crypto.mjs
// copies it over the installed Next.js extension files (both the CJS and
// ESM trees) as part of `npm run build:cf`, before the OpenNext adapter
// bundles the server. It is required for side effects only; it exports
// nothing on purpose.

/**
 * Plan-and-verify: after the agent changes files and says it's done, run
 * the project's own check (tests, else build) and hand any failure back
 * to the model to fix — before the turn ends, not after the user finds
 * out the hard way.
 *
 * detectVerifyCommand only picks commands the project itself declares
 * (package.json scripts, Makefile targets, standard test layouts). It
 * never invents one. The CLI still asks before the first run in a
 * session, like any other shell command.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Tools whose success means files on disk changed. */
export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch']);

/** True when a write tool's result says it actually wrote something. */
export function wroteFiles(name, result) {
  return WRITE_TOOLS.has(name) && /^(Wrote|Edited|Created|Patched|Deleted)\b/.test(String(result ?? ''));
}

/** Paths a successful write tool call touched, for the changed-file list. */
export function pathsFromCall(call) {
  const a = call?.args || {};
  if (call?.name === 'apply_patch' && typeof a.patch === 'string') {
    return [...a.patch.matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)].map((m) => m[1]).filter((p) => p !== '/dev/null');
  }
  return a.path ? [a.path] : [];
}

async function readJSON(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function exists(file) {
  return fs.stat(file).then(() => true, () => false);
}

const PLACEHOLDER_TEST = /no test specified/i;

/**
 * The project's own check command, or null. Order: an npm test script
 * (not the npm-init placeholder), an npm build/typecheck/lint script,
 * `make test`, pytest, cargo, go.
 */
export async function detectVerifyCommand(root) {
  const pkg = await readJSON(path.join(root, 'package.json'));
  if (pkg?.scripts) {
    const s = pkg.scripts;
    if (typeof s.test === 'string' && s.test.trim() && !PLACEHOLDER_TEST.test(s.test)) return 'npm test';
    for (const name of ['typecheck', 'check', 'lint', 'build']) {
      if (typeof s[name] === 'string' && s[name].trim()) return `npm run ${name}`;
    }
  }
  try {
    const mk = await fs.readFile(path.join(root, 'Makefile'), 'utf8');
    if (/^test\s*:/m.test(mk)) return 'make test';
  } catch {
    /* no Makefile */
  }
  if (
    (await exists(path.join(root, 'pytest.ini'))) ||
    (await exists(path.join(root, 'pyproject.toml')) && /pytest/.test(await fs.readFile(path.join(root, 'pyproject.toml'), 'utf8').catch(() => ''))) ||
    (await exists(path.join(root, 'tests')) && (await fs.readdir(path.join(root, 'tests')).catch(() => [])).some((f) => /^test_.*\.py$/.test(f)))
  ) {
    return 'python -m pytest -q';
  }
  if (await exists(path.join(root, 'Cargo.toml'))) return 'cargo test';
  if (await exists(path.join(root, 'go.mod'))) return 'go test ./...';
  return null;
}

/** Parse "exit N" from tools.mjs run() output. */
export function exitCodeOf(output) {
  const m = String(output ?? '').match(/^exit (\d+)/);
  if (m) return Number(m[1]);
  return /timed out/i.test(String(output)) ? 124 : 1;
}

/** Keep the useful end of a long test log: failures print last. */
export function tailForModel(output, limit = 6000) {
  const s = String(output ?? '');
  if (s.length <= limit) return s;
  return `… (${s.length - limit} earlier characters omitted)\n` + s.slice(-limit);
}

/** The message that sends a failure back to the model. */
export function failureMessage(command, output, attempt, maxAttempts, changed) {
  return [
    `[verify] \`${command}\` failed (exit ${exitCodeOf(output)}) after your changes to ${[...changed].join(', ') || 'the project'}. Attempt ${attempt} of ${maxAttempts}.`,
    '',
    tailForModel(output),
    '',
    'Read the failure, fix the cause in the code, and stop when done; the check runs again automatically.',
    'If this failure is unrelated to your change (it was already failing), say so in one line instead of changing unrelated code.',
  ].join('\n');
}

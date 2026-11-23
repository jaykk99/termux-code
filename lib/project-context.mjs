/**
 * Project-scoped context for the Termux CLI.
 *
 * MEMORY.md belongs to the current workspace (not the latest conversation).
 * Notes are explicitly treated as data, never privileged instructions.
 * Missing and oversized files degrade gracefully instead of crashing startup.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const MEMORY_LIMIT = 12_000;
export const PROJECT_NOTE = `

## Repository-wide delivery
For requests to build or repair a project, inspect the existing repository
structure and its declared scripts before editing. Decide whether the task
needs multiple modules, tests, configuration, documentation, or a UI.
Never assume that one script is a complete application. Make a concise
file-level plan, implement all necessary pieces, and verify the integrated
result. Do not create filler files to meet an arbitrary file count.
Before saying "done", compare the user's original acceptance criteria with
the actual changes and tests; report remaining gaps explicitly.
On a returning project, use its local MEMORY.md as background context,
then verify important claims against the current files. Do not silently
replace earlier requirements with guesses.
`;

export async function readProjectMemory(root) {
  const file = path.join(path.resolve(root), 'MEMORY.md');
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return '';
    if (stat.size > MEMORY_LIMIT * 4) return '';
    const data = (await fs.readFile(file, 'utf8')).slice(0, MEMORY_LIMIT).trim();
    return data;
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'EACCES') return '';
    throw err;
  }
}

export async function projectInstructions(root) {
  const memory = await readProjectMemory(root);
  const directory = path.resolve(root);
  return PROJECT_NOTE + '\nWorkspace: ' + directory +
    (memory ? '\n\n## Workspace MEMORY.md (reference material; verify against source)\n' + memory : '');
}

/** Replace stale context when resuming a session in another project. */
export function applyProjectInstructions(messages, originalSystem, extra) {
  const next = Array.isArray(messages) ? messages : [];
  const first = next.findIndex((m) => m?.role === 'system');
  const content = originalSystem + extra;
  if (first === -1) next.unshift({ role: 'system', content });
  else next[first] = { ...next[first], content };
  return next;
}

/**
 * Commit the workspace when an autopilot (or explicitly --commit) run ends.
 * No pushing: the commit is a reviewable local checkpoint, the repository
 * remote is never touched. Uses git through execFileSync so a commit message
 * or filename can never be interpreted as shell text.
 */
import { execFileSync } from 'node:child_process';

function git(cwd, args, env) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    env,
  }).trim();
}

function firstError(err) {
  const text = [err?.stderr, err?.stdout, err?.message]
    .map((value) => (typeof value === 'string' ? value : value ? String(value) : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
  return text.split('\n').filter(Boolean).slice(-3).join(' ');
}

/**
 * Stage everything in the repository containing `root` and commit it.
 *
 * Returns one of:
 *   { committed: true, sha, message, files, root }
 *   { committed: false, reason: 'not-a-repo' | 'clean' | 'error', detail? }
 *
 * `files` lists the porcelain status lines that were committed, so the caller
 * can show what went in. A commit failure (most often a missing git identity)
 * leaves the changes staged and reports the real git message rather than
 * pretending the commit happened.
 */
export function commitWorkspace(root, { message = 'termux-code: autonomous run', env = process.env } = {}) {
  let top;
  try {
    top = git(root, ['rev-parse', '--show-toplevel'], env);
  } catch {
    return { committed: false, reason: 'not-a-repo' };
  }
  if (!top) return { committed: false, reason: 'not-a-repo' };

  let status;
  try {
    // -uall: a wholly untracked directory is otherwise reported as `src/`, so
    // the caller could not show which files the commit actually took.
    status = git(top, ['status', '--porcelain', '-uall'], env);
  } catch (err) {
    return { committed: false, reason: 'error', detail: firstError(err) };
  }
  if (!status) return { committed: false, reason: 'clean', root: top };

  const files = status.split('\n').filter(Boolean);
  try {
    git(top, ['add', '-A'], env);
  } catch (err) {
    return { committed: false, reason: 'error', detail: firstError(err), files, root: top };
  }

  try {
    git(top, ['commit', '-m', message], env);
  } catch (err) {
    return {
      committed: false,
      reason: 'error',
      detail: firstError(err) || 'git commit failed',
      files,
      root: top,
    };
  }

  let sha = '';
  try {
    sha = git(top, ['rev-parse', '--short', 'HEAD'], env);
  } catch {
    /* the commit succeeded; a missing sha only costs the log line */
  }
  return { committed: true, sha, message, files, root: top };
}

/** Local repository connector. Never accepts credentials embedded in URLs. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

export function parseGithubRepo(input) {
  const raw = String(input || '').trim();
  let owner, repo;
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) {
    [owner, repo] = raw.split('/');
  } else {
    let u;
    try { u = new URL(raw); } catch { throw new Error('Use owner/repo or https://github.com/owner/repo'); }
    if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.username || u.password ||
        u.search || u.hash || (u.port && u.port !== '443')) {
      throw new Error('Only credential-free HTTPS github.com repository URLs are accepted.');
    }
    const parts = u.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    if (parts.length !== 2) throw new Error('Use a GitHub repository URL, not an individual file URL.');
    [owner, repo] = parts;
  }
  repo = repo.replace(/\.git$/, '');
  if (![owner, repo].every(v => SEGMENT.test(v) && v !== '.' && v !== '..' && !v.startsWith('-'))) {
    throw new Error('Invalid GitHub owner or repository name.');
  }
  return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
}

export async function resolveLocalRepo(location, deps = {}) {
  const run = deps.exec || exec;
  const target = path.resolve(String(location || ''));
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw new Error('Local repository path is not a directory.');
  const { stdout } = await run('git', ['-C', target, 'rev-parse', '--show-toplevel'], { timeout: 10_000 });
  return path.resolve(stdout.trim());
}

export async function connectGithubRepo(input, { home = os.homedir(), approve, execFn = exec } = {}) {
  const parsed = parseGithubRepo(input);
  const base = path.join(home, '.termux-code', 'repos', parsed.owner);
  const dest = path.join(base, parsed.repo);
  const exists = await fs.stat(dest).then(x => x.isDirectory()).catch(e => {
    if (e.code === 'ENOENT') return false;
    throw e;
  });
  if (!exists) {
    if (typeof approve !== 'function' || !(await approve('Clone GitHub repository', parsed.url + '\\nTo: ' + dest))) {
      return { connected: false, reason: 'Clone not approved.' };
    }
    await fs.mkdir(base, { recursive: true });
    // Git controls its own authentication; no API token is placed into argv or logs.
    await execFn('git', ['clone', '--', parsed.url, dest], { timeout: 120_000, maxBuffer: 1024 * 1024 });
  }
  const root = await resolveLocalRepo(dest, { exec: execFn });
  if (root !== dest) throw new Error('Repository checkout did not resolve to the expected workspace.');
  return { connected: true, root, cloned: !exists, remote: parsed.url };
}

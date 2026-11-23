/**
 * Launch a previously installed ReconAnything checkout on the same Android
 * device. Never clone, install packages or start a remote server implicitly.
 * The owner must explicitly request /recon start.
 */
import { promises as fs } from 'node:fs';
import { spawn as spawnChild } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { discoverReconSettings, validateReconUrl } from './recon.mjs';

export function localReconDirs(home = os.homedir()) {
  return [
    path.join(home, 'recon-anything'),
    path.join(home, 'projects', 'recon-anything'),
    path.join(home, '.termux-code', 'repos', 'jaykk99', 'recon-anything'),
  ];
}

export function isLoopbackReconUrl(url) {
  const host = new URL(validateReconUrl(url)).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

async function fileExists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function probeLocal(url, code, fetcher = fetch) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2000);
  try {
    const response = await fetcher(url + '/api/health', {
      signal: ctl.signal,
      headers: code ? { 'X-Access-Code': code } : {},
    });
    return response.ok;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

/**
 * Returns a result with ok, started and message; it does not claim the
 * backend is responsive until /api/health answers successfully.
 */
export async function startLocalRecon(config = {}, env = process.env, opts = {}) {
  const home = opts.home ?? os.homedir();
  const settings = await discoverReconSettings(config, env, { home });
  if (!settings.enabled) return { ok: false, started: false, message: 'ReconAnything is disabled. Use /recon on first.' };
  let base;
  try { base = validateReconUrl(settings.url); }
  catch (error) { return { ok: false, started: false, message: error.message }; }
  if (!isLoopbackReconUrl(base)) {
    return { ok: false, started: false, message: 'The configured scanner is remote/LAN. Start it on that device; /recon start only starts a local checkout.' };
  }

  const probe = opts.probe ?? (() => probeLocal(base, settings.code, opts.fetch));
  if (await probe()) return { ok: true, started: false, message: 'ReconAnything is already running at ' + base };

  const exists = opts.exists ?? fileExists;
  let checkout = null;
  let incomplete = null;
  for (const dir of localReconDirs(home)) {
    if (!(await exists(path.join(dir, 'local-run', 'termux-start.sh')))) continue;
    if (await exists(path.join(dir, '.local-env')) &&
        await exists(path.join(dir, '.venv', 'bin', 'python')) &&
        await exists(path.join(dir, 'frontend', '.next', 'standalone', 'server.js'))) {
      checkout = dir;
      break;
    }
    incomplete = dir;
  }
  if (!checkout) {
    return {
      ok: false, started: false,
      message: incomplete
        ? 'ReconAnything found at ' + incomplete + ', but setup is incomplete. Run: cd ' + incomplete + ' && bash local-run/termux-setup.sh'
        : 'ReconAnything is not installed locally. Clone jaykk99/recon-anything into ~/recon-anything and run bash local-run/termux-setup.sh once.',
    };
  }

  const stateDir = path.join(home, '.termux-code');
  const pidPath = path.join(stateDir, 'recon-anything.pid');
  const logPath = path.join(stateDir, 'recon-anything.log');
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  try {
    const savedPid = Number((await fs.readFile(pidPath, 'utf8')).trim());
    if (Number.isSafeInteger(savedPid) && savedPid > 0) {
      const alive = opts.pidAlive ?? ((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
      if (alive(savedPid)) {
        return { ok: false, started: true, message: 'ReconAnything process ' + savedPid + ' is still starting. Try /recon again; if it remains unavailable inspect ' + logPath };
      }
    }
  } catch { /* no previous pid */ }

  const log = await fs.open(logPath, 'a', 0o600);
  let child;
  try {
    const launch = opts.spawn ?? spawnChild;
    child = launch('bash', [path.join(checkout, 'local-run', 'termux-start.sh')], {
      cwd: checkout, detached: true, stdio: ['ignore', log.fd, log.fd],
      env: { ...env, RECON_BIND_HOST: '127.0.0.1' },
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    await fs.writeFile(pidPath, String(child.pid) + '\n', { mode: 0o600 });
  } catch (error) {
    return { ok: false, started: false, message: 'Could not launch ReconAnything: ' + error.message };
  } finally {
    await log.close();
  }
  const sleep = opts.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(1000);
    if (await probe()) {
      return { ok: true, started: true, message: 'ReconAnything started on ' + base + ' (pid ' + child.pid + ').' };
    }
  }
  return {
    ok: false, started: true,
    message: 'Started ReconAnything (pid ' + child.pid + '), but its API is not ready yet. Check /recon again. Startup log: ' + logPath,
  };
}

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * ReconAnything bridge for the Termux CLI. No third-party SDK and no shell:
 * the local agent talks to ReconAnything's existing JSON API.
 *
 * The URL and access code come only from owner config or environment, never
 * from model-generated tool arguments. A down backend is an actionable error,
 * not a reason to fall back to arbitrary shell "hacking" commands.
 */
const DEFAULT_URL = 'http://127.0.0.1:8000';
const MAX_OUTPUT = 16_000;
const MAX_FINDINGS = 200;

export const RECON_TOOL = {
  name: 'recon_anything',
  description: 'Use the connected ReconAnything scanner for authorized cybersecurity reconnaissance, pentests, bug-bounty work, domain/URL/IP inspection, OSINT and vulnerability findings. Actions: health, plugins, start_scan, scan_status, findings, list_scans. Prefer passive scans; active requires explicit /recon active on in this Termux session. Do not substitute generic bash scanning when ReconAnything is available.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['health', 'plugins', 'start_scan', 'scan_status', 'findings', 'list_scans'] },
      targets: { type: 'string', description: 'Domain(s), URL(s), or IP(s) to scan, separated by whitespace or newlines.' },
      mode: { type: 'string', enum: ['passive', 'active'], description: 'Default passive. Active is only enabled by the owner via /recon active on.' },
      authorized: { type: 'boolean', description: 'Set true ONLY after the user confirms they own the target or have permission to test it. Required for start_scan.' },
      plugins: { type: 'array', items: { type: 'string' }, description: 'Optional plugin ids from plugins action.' },
      bounty: { type: 'boolean', description: 'Prioritize security findings; default false.' },
      run_id: { type: 'string', description: 'Scan id returned by start_scan.' },
      severity: { type: 'string', description: 'Optional severity filter for findings.' },
      limit: { type: 'integer', description: 'Maximum results, 1-200.' },
    },
    required: ['action'],
  },
};

export const RECON_HINT = '\n\nReconAnything workflow: If the current request is about hacking, pentesting, vulnerability assessment, OSINT, scanning or bug bounties, first use the recon_anything tool (health/plugins as appropriate). Ask for a target if none is given. Before starting a scan, ensure the user owns or is authorized to assess the target; set authorized=true only with that confirmation. Prefer passive scanning. Poll scan_status, then read findings, and distinguish verified findings from hypotheses. Never claim the tool is connected if health fails. Active scanning needs the explicit in-session /recon active on switch.';

export function isReconIntent(text) {
  return /\b(?:hack(?:ing|er)?|pentest(?:ing)?|penetration\s+test|recon(?:naissance)?|vuln(?:erabilit(?:y|ies))?|bug\s+bount(?:y|ies)|osint|security\s+(?:scan|audit|test|assessment)|scan\s+(?:a\s+)?(?:site|website|domain|url|ip|host))\b/i.test(String(text || ''));
}

export function withReconHint(system, request) {
  const base = String(system ?? '').split(RECON_HINT).join('');
  return isReconIntent(request) ? base + RECON_HINT : base;
}

export function validateReconUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw new Error('Recon URL must be an http(s) base URL, for example http://127.0.0.1:8000.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Recon URL must be an http(s) origin without credentials, a path, or query parameters.');
  }
  // Never send the access code in plaintext to an arbitrary public server.
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    throw new Error('Plain HTTP is permitted only for localhost/private-network Recon servers. Use HTTPS for public servers.');
  }
  return url.origin;
}

function isLocalHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '127.0.0.1') return true;
  const octets = h.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 169 && octets[1] === 254);
}

export function reconSettings(config = {}, env = process.env) {
  return {
    enabled: config.reconDisabled !== true,
    url: env.RECON_API_URL || config.reconApiUrl || DEFAULT_URL,
    code: env.RECON_ACCESS_CODE || config.reconAccessCode || '',
  };
}

/**
 * Same-device plug-and-play: read the local setup-generated code from the
 * known ReconAnything checkout locations. Never attach a local token to a
 * remote server; remote/LAN URLs must use explicit owner configuration.
 */
export async function discoverReconSettings(config = {}, env = process.env, { home = os.homedir(), readFile = fs.readFile } = {}) {
  const settings = reconSettings(config, env);
  if (!settings.enabled || settings.code) return settings;
  let host;
  try { host = new URL(validateReconUrl(settings.url)).hostname; }
  catch { return settings; }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return settings;
  const known = [
    path.join(home, 'recon-anything', '.local-access-code'),
    path.join(home, 'projects', 'recon-anything', '.local-access-code'),
    path.join(home, '.termux-code', 'repos', 'jaykk99', 'recon-anything', '.local-access-code'),
  ];
  for (const file of known) {
    try {
      const code = (await readFile(file, 'utf8')).trim();
      if (code && code.length <= 512) return { ...settings, code };
    } catch { /* this checkout is not installed */ }
  }
  return settings;
}

function clipped(value) {
  const str = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return str.length > MAX_OUTPUT ? str.slice(0, MAX_OUTPUT) + '\n... [output truncated]' : str;
}

export async function runReconTool(args = {}, ctx = {}) {
  const action = String(args.action || '').trim();
  const settings = await (ctx.recon || discoverReconSettings());
  if (!settings.enabled) return 'ReconAnything is disabled. Enable it with /recon on.';
  let base;
  try { base = validateReconUrl(settings.url); }
  catch (e) { return 'ReconAnything configuration error: ' + e.message; }

  const fetcher = ctx.fetch || fetch;
  async function call(method, endpoint, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), method === 'POST' ? 30_000 : 15_000);
    try {
      const response = await fetcher(base + endpoint, {
        method,
        signal: ctl.signal,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(settings.code ? { 'X-Access-Code': settings.code } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const raw = (await response.text()).slice(0, 2_000_000);
      if (!response.ok) {
        const detail = raw.slice(0, 400);
        throw new Error('HTTP ' + response.status + ': ' + detail);
      }
      try { return JSON.parse(raw); }
      catch { throw new Error('ReconAnything returned invalid JSON.'); }
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    if (action === 'health') {
      const health = await call('GET', '/api/health');
      return clipped({ connected: true, api: base, health });
    }
    if (action === 'plugins') {
      const data = await call('GET', '/api/plugins');
      const plugins = Array.isArray(data?.plugins) ? data.plugins : [];
      return clipped({ total: plugins.length, plugins: plugins.slice(0, 100).map(p => ({
        id: p.id, name: p.name, category: p.category, mode: p.mode, requires_keys: p.requires_keys,
      })) });
    }
    if (action === 'start_scan') {
      const targets = typeof args.targets === 'string' ? args.targets.trim() : '';
      if (!targets || targets.length > 4000) return 'start_scan requires targets (1-4000 characters).';
      if (args.authorized !== true) {
        return 'Scan not started: ask the user to confirm they own or have permission to assess these targets, then call with authorized=true.';
      }
      const mode = args.mode || 'passive';
      if (!['passive', 'active'].includes(mode)) return 'Mode must be passive or active.';
      if (mode === 'active' && ctx.reconActive !== true) {
        return 'Active scan not started. The owner must explicitly type /recon active on in this Termux session; passive mode is available.';
      }
      const body = { targets, mode, bounty: args.bounty === true };
      if (Array.isArray(args.plugins) && args.plugins.length) {
        if (args.plugins.length > 100 || args.plugins.some(p => typeof p !== 'string' || !/^[\w.-]{1,100}$/.test(p))) {
          return 'Invalid plugin ids: supply up to 100 ids from the plugins action.';
        }
        body.plugins = args.plugins;
      }
      if (typeof ctx.approve === 'function') {
        const approved = await ctx.approve('ReconAnything ' + mode + ' scan', targets);
        if (!approved) return 'Recon scan declined by the user.';
      }
      return clipped(await call('POST', '/api/runs', body));
    }
    if (action === 'list_scans') {
      const data = await call('GET', '/api/runs');
      const runs = Array.isArray(data?.runs) ? data.runs : Array.isArray(data) ? data : [];
      return clipped({ runs: runs.slice(0, Math.min(100, Math.max(1, Number(args.limit) || 20))) });
    }
    if (action === 'scan_status' || action === 'findings') {
      const runId = typeof args.run_id === 'string' ? args.run_id.trim() : '';
      if (!/^[\w-]{1,128}$/.test(runId)) return action + ' requires a valid run_id.';
      const data = await call('GET', '/api/runs/' + encodeURIComponent(runId));
      if (action === 'scan_status') return clipped({
        run: data.run, progress: data.progress, finding_count: Array.isArray(data.findings) ? data.findings.length : 0,
      });
      let findings = Array.isArray(data.findings) ? data.findings : [];
      if (args.severity) findings = findings.filter(f => String(f.severity || '').toLowerCase() === String(args.severity).toLowerCase());
      const limit = Math.min(MAX_FINDINGS, Math.max(1, Number(args.limit) || 50));
      return clipped({ total_matching: findings.length, returned: Math.min(findings.length, limit),
        executive_summary: data.executive_summary, findings: findings.slice(0, limit) });
    }
    return 'Unknown ReconAnything action. Use health, plugins, start_scan, scan_status, findings, or list_scans.';
  } catch (e) {
    const detail = e.name === 'AbortError' ? 'request timed out' : e.message;
    return 'ReconAnything unavailable at ' + base + ': ' + detail +
      '. Start its backend with bash local-run/termux-start.sh or linux-start.sh, or configure /recon url <base-url>.';
  }
}

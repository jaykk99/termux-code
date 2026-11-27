// Read-only defensive workspace audit. Never reads credential contents,
// follows symlinks, runs commands, or makes network calls.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache']);
function sensitive(name) {
  if (/^\.env\.(example|sample|template)$/i.test(name)) return false;
  return /^\.env(?:\.|$)|^\.npmrc$|^id_(?:rsa|ed25519|ecdsa)$|\.(?:key|p12|pfx)$|^(?:credentials|secrets|gateway-tokens)\.json$/i.test(name);
}

export async function auditWorkspace(root, { maxEntries = 1500 } = {}) {
  const limit = Math.min(1500, Math.max(1, Number(maxEntries) || 1500));
  const base = await fs.realpath(root);
  const queue = [base];
  const findings = [];
  const severityCounts = { high: 0, medium: 0, info: 0 };
  let inspected = 0, unreadable = 0, omittedFindings = 0;
  const add = finding => {
    severityCounts[finding.severity]++;
    if (findings.length < 50) findings.push(finding);
    else {
      omittedFindings++;
      const lower = findings.findIndex(f => f.severity === 'info' && finding.severity !== 'info' || f.severity === 'medium' && finding.severity === 'high');
      if (lower !== -1) findings[lower] = finding;
    }
  };
  let truncated = false;
  while (queue.length && !truncated) {
    const dir = queue.shift();
    let handle;
    try {
      const actual = await fs.realpath(dir);
      if (actual !== dir || (actual !== base && !actual.startsWith(base + path.sep))) {
        unreadable++;
        continue;
      }
      handle = await fs.opendir(actual);
    } catch { unreadable++; continue; }
    for await (const entry of handle) {
      if (inspected >= limit) { truncated = true; break; }
      inspected++;
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(base, full);
      let st;
      try { st = await fs.lstat(full); } catch { unreadable++; continue; }
      if (st.isSymbolicLink()) {
        add({ severity: 'info', rule: 'SYMLINK_REVIEW', path: relative, remediation: 'Review the link destination before allowing agent reads or writes.' });
      } else if (st.isDirectory()) {
        // Recheck before queueing; not a sandbox against concurrent hostile changes.
        queue.push(full);
      } else if (st.isFile() && sensitive(entry.name) && (st.mode & 0o077)) {
        add({ severity: 'high', rule: 'CREDENTIAL_FILE_PERMISSIONS', path: relative, evidence: 'mode ' + (st.mode & 0o777).toString(8), remediation: 'Restrict access to the owner where supported; review whether credentials need rotation.' });
      }
    }
  }
  async function regular(name) {
    try { return (await fs.lstat(path.join(base, name))).isFile(); } catch { return false; }
  }
  if (await regular('package.json') && !(await Promise.all(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].map(regular))).some(Boolean)) {
    add({ severity: 'medium', rule: 'MISSING_DEPENDENCY_LOCK', path: 'package.json', remediation: 'Commit the appropriate package manager lockfile for reproducible dependency review.' });
  }
  return { inspected, truncated, unreadable, omittedFindings, severityCounts, findings, limitations: 'Metadata-only audit; no secret values, dependency CVE lookup, exploit testing, or guarantee of workspace isolation.' };
}

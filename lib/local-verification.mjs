// Explicitly local verification; never executes workspace code or invokes a model.
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { auditWorkspace } from './security-audit.mjs';

const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_FILES = 300;
const SKIP = new Set(['.git','node_modules','.next','dist','build','coverage','.cache']);
const kind = name => name === 'package.json' || name === 'package-lock.json' ? 'json'
  : name.endsWith('.mjs') ? 'module' : name.endsWith('.cjs') ? 'commonjs' : null;

async function parseOnly(text, type, timeout) {
  if (type === 'json') {
    try { JSON.parse(text); return 'passed'; } catch { return 'failed'; }
  }
  return new Promise(resolve => {
    let timedOut = false;
    const child = spawn(process.execPath, ['--check', '--input-type='+type], {
      env: {}, stdio: ['pipe','ignore','ignore'], shell: false,
    });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); resolve('unavailable'); });
    child.on('close', code => { clearTimeout(timer); resolve(timedOut ? 'timeout' : code === 0 ? 'passed' : code === 1 ? 'failed' : 'unavailable'); });
    child.stdin.end(text);
  });
}

export async function verifyLocalProject(root, { durationMs = 60000 } = {}) {
  const base = await fs.realpath(root);
  const duration = Number.isFinite(durationMs) ? Math.min(60000, Math.max(1,durationMs)) : 60000;
  const deadline = performance.now()+duration;
  const remaining = () => Math.floor(deadline-performance.now());
  const audit = await auditWorkspace(base, {maxDurationMs: Math.max(1,remaining())});
  const queue = [base];
  const checks = [];
  let entries = 0, stopReason = 'complete', unreadable = 0;
  for (let cursor=0; cursor<queue.length && stopReason==='complete'; cursor++) {
    if (remaining()<=0) { stopReason='time_limit'; break; }
    const dir = queue[cursor];
    let handle;
    try {
      if (await fs.realpath(dir) !== dir) { unreadable++; continue; }
      handle = await fs.opendir(dir);
    } catch { unreadable++; continue; }
    try {
      for await (const entry of handle) {
        if (remaining()<=0 || entries>=MAX_ENTRIES) {
          stopReason=remaining()<=0?'time_limit':'entry_limit'; break;
        }
        entries++;
        if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
        const full=path.join(dir,entry.name);
        let st;
        try { st=await fs.lstat(full); } catch { unreadable++; continue; }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) { queue.push(full); continue; }
        const type=kind(entry.name);
        if (!type || !st.isFile()) continue;
        if (checks.length>=MAX_FILES) {stopReason='file_limit'; break;}
        const relative=path.relative(base,full);
        let status='unavailable';
        let file;
        try {
          if (st.size>MAX_BYTES) status='size_limit';
          else {
            file=await fs.open(full,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const actual=await file.stat();
            if (!actual.isFile() || actual.size>MAX_BYTES) status='size_limit';
            else {
              const buf=Buffer.alloc(actual.size+1);
              let bytesRead=0;
              while (bytesRead<buf.length && remaining()>0) {
                const next=await file.read(buf,bytesRead,buf.length-bytesRead,bytesRead);
                if (!next.bytesRead) break;
                bytesRead+=next.bytesRead;
              }
              if (remaining()<=0) status='timeout';
              else if (bytesRead!==actual.size) status='changed_during_read';
              else status=await parseOnly(buf.subarray(0,bytesRead).toString('utf8'),type,Math.min(5000,Math.max(1,remaining())));
            }
          }
        } catch { status='unavailable'; }
        finally { if(file) await file.close().catch(()=>{}); }
        checks.push({path:relative,type,status});
      }
    } catch { unreadable++; }
  }
  const failed=checks.filter(c=>c.status==='failed').length;
  const incomplete=checks.filter(c=>!['passed','failed'].includes(c.status)).length;
  if (stopReason==='complete' && remaining()<=0) stopReason='time_limit';
  if (stopReason==='complete' && (unreadable || incomplete || !audit.complete)) stopReason='incomplete_checks';
  if (stopReason==='complete' && !checks.length) stopReason='no_supported_files';
  const complete=stopReason==='complete';
  return {complete,stopReason,entries,checked:checks.length,failed,incomplete,unreadable,checks,audit,
    ok:complete && failed===0 && audit.severityCounts.high===0,
    limitations:'Local metadata and syntax checks only. Does not execute project code, tests, builds or network operations; skips .js/.jsx/.ts and non-manifest JSON; not a filesystem isolation boundary.'};
}

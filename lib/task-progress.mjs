/**
 * Evidence-based continuation for long tasks. A model's statement "I'll do it"
 * is not evidence that it inspected files, visited URLs or made changes.
 * This guard is bounded; it never turns a failed provider into an endless loop.
 */
const IMPLEMENT = /\b(?:build|implement|create|code|write|fix|repair|refactor|upgrade|integrate|wire|modify|change|complete|finish|add|make)\b/i;
const ARTIFACT = /\b(?:repo|repository|project|app|website|site|script|file|files|code|bug|test|feature|frontend|backend|api|module|component|program|cli)\b/i;
const WRITE = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch']);
const READ = new Set(['read_file', 'read_files', 'project_map', 'list_dir', 'grep']);
const URL = /https?:\/\/[^\s<>\])"'\x60]+/gi;

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch { return null; }
}

export function createTaskProgress(prompt = '') {
  const value = String(prompt);
  const urls = [...new Set((value.match(URL) || []).map(normalizeUrl).filter(Boolean))];
  return {
    coding: IMPLEMENT.test(value) && ARTIFACT.test(value),
    urls,
    visitedUrls: new Set(),
    inspected: false,
    changed: false,
    tested: false,
    nudges: 0,
  };
}

export function observeTaskTool(state, name, args = {}, result = '') {
  if (!state) return;
  const response = String(result ?? '');
  const denied = /Declined by the user|Nothing was written|Unknown tool|Error:|could not|does not exist/i.test(response.slice(0, 250));
  if (READ.has(name)) state.inspected = true;
  if (name === 'bash') {
    const cmd = String(args.command || '');
    if (/\b(?:ls|find|cat|sed|rg|grep|git status|git ls-files)\b/.test(cmd)) state.inspected = true;
    if (/\b(?:npm test|pytest|cargo test|go test|make test|npm run build|node --test)\b/.test(cmd)) state.tested = true;
  }
  if (name === 'run_tests') state.tested = true;
  if (WRITE.has(name) && !denied && /\b(?:Wrote|Edited|Patched|Created|Deleted)\b/.test(response.slice(0, 200))) state.changed = true;
  if ((name === 'fetch_url' || name === 'browser') && (name !== 'browser' || ['open','read'].includes(args.action))) {
    const normalized = normalizeUrl(args.url || '');
    if (normalized) state.visitedUrls.add(normalized);
  }
}

export function continuationInstruction(state) {
  if (!state || state.nudges >= 2) return null;
  const missing = state.urls.filter(url => !state.visitedUrls.has(url));
  if (missing.length) {
    return 'You have not yet attempted these URL(s): ' + missing.slice(0, 5).join(', ') +
      '. Use fetch_url or browser to inspect them before answering; if access fails, say so and do not invent their contents.';
  }
  if (state.coding && !state.inspected) {
    return 'The user requested actual project implementation, not a proposed plan. Inspect the workspace with list_dir/read_file/grep or bash, then implement the necessary files. If access is unavailable, report that accurately.';
  }
  if (state.coding && !state.changed) {
    return 'No successful file edits have been observed for this implementation request. Continue with write_file, edit_file, multi_edit or apply_patch as appropriate, then run project checks. If no change is required, justify that using inspected evidence.';
  }
  return null;
}

export function requestContinuation(state, messages) {
  const note = continuationInstruction(state);
  if (!note) return false;
  state.nudges++;
  messages.push({ role: 'user', content: '[Task completion check] ' + note });
  return true;
}

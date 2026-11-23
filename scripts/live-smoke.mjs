#!/usr/bin/env node
/**
 * Live smoke test: a real GitHub checkout, real code execution, real
 * uncensored routes.
 *
 * tests/ stubs fetch, so no suite in `npm test` can see a route that answers
 * with a refusal, an empty generation, or a tool call its wire format drops.
 * This does the opposite, end to end:
 *
 *   1. clones a real GitHub repo (default: this one) into a temp dir,
 *   2. runs code in that checkout with the real lib/tools.mjs runner and the
 *      repo's own test file — before any model is involved, so a broken
 *      checkout/exec path is reported separately from a broken model,
 *   3. asks each runnable uncensored model to run a shell command and write
 *      a file there, executing every tool call it returns.
 *
 * A route fails when it errors, refuses, never drives a tool, or runs a
 * command without ever writing the file it was asked for.
 * Only uncensored-lineage routes run: the list comes from directModels(env)
 * and every entry is re-checked with isUncensoredModel().
 *
 * With --task the same loop runs a real task in the checkout instead of the
 * smoke proof: the model writes the changes, and --push commits them to a new
 * branch and pushes that branch back to the repo (needs GITHUB_TOKEN).
 *
 * Usage:
 *   node scripts/live-smoke.mjs                     # every runnable route
 *   node scripts/live-smoke.mjs --route horde/any   # one route
 *   node scripts/live-smoke.mjs --repo jaykk99/termux-code --branch main
 *   node scripts/live-smoke.mjs --json --keep
 *   npm run test:live
 *
 *   # use your own repo for a real task
 *   node scripts/live-smoke.mjs --repo you/thing --route horde/any \
 *     --task "add a --dry-run flag to bin/thing.mjs"
 *   node scripts/live-smoke.mjs ... --push    # commit + push a new branch
 *
 * Keys come from the environment or .env. Exit: 0 all routes passed,
 * 1 a route, the checkout or the flags failed, 2 nothing runnable (no keys set).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/* ---------- args ---------- */

export function parseArgs(argv) {
  const out = { repo: 'jaykk99/termux-code', branch: null, route: null, task: null, push: false, steps: null, retry: true, json: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--keep') out.keep = true;
    else if (a === '--no-retry') out.retry = false;
    else if (a === '--push') out.push = true;
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--branch') out.branch = argv[++i];
    else if (a === '--route') out.route = argv[++i];
    else if (a === '--task') out.task = argv[++i];
    else if (a === '--steps') out.steps = Math.max(1, Number(argv[++i]) || 0) || null;
    else if (a === '-h' || a === '--help') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  // A task needs room to read, edit and check its work; the smoke proof needs
  // two tool calls. Both can be overridden with --steps.
  if (out.steps === undefined) out.steps = null;
  out.steps = out.steps || (out.task ? 12 : 4);
  return out;
}

/**
 * Flag combinations that cannot work, answered before a repo is cloned.
 * --push without --task would commit the smoke marker as if it were work, and
 * a task without a repo checkout has nowhere to write.
 */
export function modeProblem(args) {
  if (args.push && !args.task) return '--push needs --task: there is nothing to commit from the smoke proof.';
  if (args.task && !String(args.task).trim()) return '--task needs the task text, e.g. --task "add a --dry-run flag".';
  return null;
}

/** .env wins only where the shell left a name unset, like the CLI expects. */
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

/* ---------- refusal detection ---------- */

/** Text that means the route answered with a refusal instead of doing the job. */
const REFUSALS = [
  /\bI(?:'m| am) (?:sorry|afraid)\b/i,
  /\bI can(?:'|no)t (?:help|assist|do|provide|comply|write|run|create)\b/i,
  /\bI (?:won't|will not|am not able to|am unable to|must decline)\b/i,
  /\bcan(?:'|no)t (?:help|assist|do that|comply)\b/i,
  /\bAs an AI\b/i,
  /\bagainst my (?:guidelines|polic(?:y|ies)|safety|programming)\b/i,
  /\bnot comfortable\b/i,
  /\bharmful (?:content|request)\b/i,
];

function findRefusal(text) {
  const s = String(text || '');
  for (const re of REFUSALS) if (re.test(s)) return s.replace(/\s+/g, ' ').trim().slice(0, 220);
  return null;
}

/* ---------- git ---------- */

/**
 * GITHUB_TOKEN stays out of argv (visible in ps) by going through git's
 * GIT_CONFIG_* env passthrough instead of a credential in the URL.
 */
function gitEnv(source = process.env) {
  const env = { ...source };
  if (env.GITHUB_TOKEN) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 =
      'AUTHORIZATION: basic ' + Buffer.from(`x-access-token:${env.GITHUB_TOKEN}`).toString('base64');
  }
  return env;
}

function cloneRepo(repo, dir, branch) {
  const args = ['clone', '--depth', '1', '--quiet'];
  if (branch) args.push('--branch', branch);
  args.push(`https://github.com/${repo}.git`, dir);
  execFileSync('git', args, { env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  return {
    sha: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(),
    files: execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean).length,
  };
}

/* ---------- writing to the checkout ---------- */

/**
 * Every path the checkout now has changed or added, from git itself. A task
 * counted as done only when this is non-empty: a model that only read files,
 * or talked about the change, has not done the task.
 */
export function gitChanges(dir) {
  let out;
  try {
    out = execFileSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch {
    return [];
  }
  return out
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const rel = line.slice(3).trim();
      const arrow = rel.indexOf(' -> ');
      return arrow === -1 ? rel : rel.slice(arrow + 4);
    });
}

/** The commit subject is the task's first line; the body keeps the rest. */
export function commitMessage(task, model) {
  const lines = String(task).split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines[0] || 'agent task';
  const subject = first.length > 60 ? `${first.slice(0, 57)}…` : first;
  const body = [`Task: ${lines.join(' ').slice(0, 1000)}`, `Model: ${model.provider}/${model.id}`, '', 'Written by termux-code in a live harness checkout.'];
  return `${subject}\n\n${body.join('\n')}`;
}

/** The new branch a pushed task lands on, never a protected one. */
export function branchFor(model, token) {
  const route = `${model.provider}-${model.id}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `live/${route}-${String(token).replace(/[^A-Za-z0-9]+/g, '').toLowerCase()}`;
}

/**
 * Commit the checkout's changes and push them as a new branch on the repo.
 * The token stays out of argv (gitEnv passes it through GIT_CONFIG_*), and a
 * task never lands on main: the point is a branch you can review first.
 */
export function pushChanges({ dir, repo, branch, env = process.env, message, remote }) {
  if (!env.GITHUB_TOKEN) throw new Error('--push needs GITHUB_TOKEN in the environment or .env so git can push.');
  if (!branch || /^(main|master)$/.test(branch)) throw new Error('refusing to push a task to the default branch; pass a new branch name.');
  const changes = gitChanges(dir);
  if (!changes.length) throw new Error('nothing to push: the checkout has no changes.');
  const git = (args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: gitEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
    });
  git(['add', '-A']);
  git([
    '-c', 'user.name=termux-code agent',
    '-c', 'user.email=termux-code@users.noreply.github.com',
    'commit', '--quiet', '-m', message,
  ]);
  const sha = git(['rev-parse', '--short', 'HEAD']).trim();
  // `remote` is only the test seam: a local bare repo instead of GitHub.
  const to = remote || `https://github.com/${repo}.git`;
  git(['push', '--quiet', to, `HEAD:refs/heads/${branch}`]);
  return { branch, sha, files: changes };
}

/* ---------- report ---------- */

function table(rows) {
  const head = ['route', 'status', 'ms', 'try', 'tools', 'note'];
  const body = rows.map((r) => [
    r.route,
    r.status,
    String(r.ms),
    String(r.attempts ?? 1),
    r.tools.join(',') || '-',
    r.note,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(head), line(widths.map((w) => '─'.repeat(w))), ...body.map(line)].join('\n');
}

/* ---------- main ---------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnv(path.join(ROOT, '.env'));

  const problem = modeProblem(args);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  if (args.push && !process.env.GITHUB_TOKEN) {
    console.error('--push needs GITHUB_TOKEN in the environment or .env so git can push the branch.');
    process.exit(1);
  }

  const { directModels } = await import('../lib/models.mjs');
  const { isUncensoredModel } = await import('../lib/uncensored.mjs');
  const agent = await import('../lib/agent.mjs');
  const { runTool } = await import('../lib/tools.mjs');

  const env = process.env;
  const runnable = directModels(env);
  const aligned = runnable.filter((m) => !isUncensoredModel(m));
  const routes = args.route
    ? runnable.filter((m) => `${m.provider}/${m.id}` === args.route)
    : runnable;
  const token = newToken();
  const result = { ok: true, repo: null, checkout: {}, routes: [], token };

  if (aligned.length) {
    result.ok = false;
    result.policy = `aligned models reached directModels(): ${aligned.map((m) => `${m.provider}/${m.id}`).join(', ')}`;
  }

  if (args.route && !routes.length) {
    console.error(`no runnable uncensored route matches ${args.route}`);
    console.error(`runnable now: ${runnable.map((m) => `${m.provider}/${m.id}`).join(', ') || '(none)'}`);
    process.exit(2);
  }

  // A task writes into a checkout, so one route per run keeps the diff — and
  // the branch --push creates — attributable to the model that made it.
  if (args.task && routes.length > 1) routes.splice(1);

  /* --- 1. real GitHub checkout --- */
  const dir = mkdtempSync(path.join(os.tmpdir(), 'termux-code-live-'));
  try {
    try {
      const info = cloneRepo(args.repo, dir, args.branch);
      result.repo = { name: args.repo, ...info };
    } catch (err) {
      result.ok = false;
      result.checkout.cloneError = String(err.stderr?.toString?.() || err.message || err)
        .split('\n')
        .filter(Boolean)
        .slice(-3)
        .join(' ');
    }

    if (result.repo) {
      /* --- 2. real code execution, no model involved --- */
      const approve = async () => true;
      try {
        const out = await runTool('bash', { command: 'node -e "process.stdout.write(String(6*7))"' }, { root: dir, approve });
        result.checkout.bash42 = /\b42\b/.test(String(out));
      } catch (err) {
        result.checkout.bash42 = false;
        result.checkout.bashError = String(err.message || err);
      }
      const probe = path.join(dir, 'smoke-local.txt');
      try {
        await runTool('write_file', { path: 'smoke-local.txt', content: token }, { root: dir, approve });
        result.checkout.writeFile = existsSync(probe) && readFileSync(probe, 'utf8').includes(token);
      } catch (err) {
        result.checkout.writeFile = false;
        result.checkout.writeError = String(err.message || err);
      } finally {
        // The probe is the harness's own file, not the model's work: left in
        // the checkout it would read as a changed file in task mode (seen
        // live 2026-11-23, a no-tool attempt reported "1 file(s) changed").
        rmSync(probe, { force: true });
      }
      try {
        execFileSync('node', ['--test', 'tests/text-tools.test.mjs'], { cwd: dir, stdio: 'pipe', timeout: 120_000 });
        result.checkout.repoTests = 'pass';
      } catch (err) {
        result.checkout.repoTests = 'fail';
        result.checkout.repoTestsError = String(err.stderr?.toString?.() || err.message || err)
          .split('\n')
          .filter(Boolean)
          .slice(-4)
          .join(' ');
      }
      if (!result.checkout.bash42 || !result.checkout.writeFile || result.checkout.repoTests === 'fail') {
        result.ok = false;
      }
    }

    /* --- 3. one agent turn per uncensored route, tools executed for real --- */
    if (result.repo && routes.length) {
      for (const model of routes) {
        const row = args.task
          ? await taskRoute(model, { dir, env, steps: args.steps, agent, runTool, retry: args.retry, task: args.task })
          : await smokeRoute(model, { dir, env, steps: args.steps, agent, runTool, retry: args.retry });
        result.routes.push(row);
        if (!args.task) continue;
        result.changes = row.files || [];
        if (!args.push) continue;
        if (row.status !== 'ok') {
          result.pushed = { error: `route was ${row.status}, so nothing was pushed` };
          continue;
        }
        try {
          result.pushed = pushChanges({
            dir,
            repo: args.repo,
            branch: branchFor(model, row.token),
            env,
            message: commitMessage(args.task, model),
          });
        } catch (err) {
          result.ok = false;
          result.pushed = { error: oneLine(err?.message || err) };
        }
      }
    }

    if (result.routes.some((r) => r.status !== 'ok')) result.ok = false;

    /* --- report --- */
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`repo      ${result.repo ? `${result.repo.name}@${result.repo.sha} (${result.repo.files} files, ${dir})` : `clone failed: ${result.checkout.cloneError || 'unknown'}`}`);
      if (result.repo) {
        const c = result.checkout;
        console.log(`checkout  bash=${c.bash42 ? 'ok' : 'FAIL'} write_file=${c.writeFile ? 'ok' : 'FAIL'} repo-tests=${c.repoTests}${c.repoTestsError ? ` (${c.repoTestsError})` : ''}`);
      }
      if (result.policy) console.log(`policy    FAIL — ${result.policy}`);
      if (!routes.length) {
        const keys = ['VENICE_API_KEY', 'NAGA_API_KEY', 'OPENROUTER_API_KEY', 'DEEPINFRA_API_KEY', 'LLM7_API_KEY', 'HF_TOKEN'];
        const missing = keys.filter((k) => !env[k]);
        console.log(`routes    none runnable — set a key in .env (${missing.join(', ')}) or have uncensored workers online for horde`);
      } else {
        console.log(`\n${table(result.routes)}\n`);
        // The raw answer is what makes a failed route diagnosable: a refusal
        // and a model that only described the command look the same in a table.
        for (const r of result.routes.filter((x) => x.status !== 'ok' && x.reply)) {
          console.log(`  ${r.route} said: ${r.reply}`);
        }
        console.log(
          args.task
            ? `${result.routes.filter((r) => r.status === 'ok').length}/${result.routes.length} uncensored routes did the task and left the change in the checkout`
            : `${result.routes.filter((r) => r.status === 'ok').length}/${result.routes.length} uncensored routes ran a command and wrote smoke.txt in the checkout`,
        );
        if (args.task) {
          const files = result.changes || [];
          console.log(`changes   ${files.length ? `${files.length} file(s): ${files.slice(0, 10).join(', ')}${files.length > 10 ? ` … +${files.length - 10}` : ''}` : 'none — nothing to commit'}`);
          if (args.push && result.repo) {
            console.log(
              result.pushed?.branch
                ? `pushed    ${result.pushed.branch} @ ${result.pushed.sha}`
                : `push      FAILED — ${result.pushed?.error || 'unknown error'}`,
            );
          }
        }
      }
    }

    if (!args.keep) rmSync(dir, { recursive: true, force: true });
    else console.log(`checkout kept at ${dir}`);

    process.exit(result.ok ? 0 : result.repo || args.route ? 1 : 2); // 2 = nothing runnable
  } finally {
    if (!args.keep && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The pass rule, in one place so tests can pin it: a route only passes when
 * it ran a command AND left the file holding this attempt's token, and a
 * refusal outranks the rest.
 */
export function routeStatus({ refusal = null, bashRan = false, wrote = false } = {}) {
  return refusal ? 'refusal' : !bashRan ? 'no-tool' : !wrote ? 'no-file' : 'ok';
}

/** A fresh job marker per attempt, so a pass is never inherited from an earlier one. */
function newToken() {
  return `SMOKE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/**
 * One route, one attempt: run a shell command and write a file in the
 * checkout. Every tool call the model returns is executed by lib/tools.mjs,
 * with the results fed back the way the real agent loop feeds them, until
 * the model answers without tools or the step budget runs out.
 */
/**
 * The agent loop itself, shared by both modes: ask the model, run every tool
 * call it returns through the real runner, feed the results back, stop when
 * it answers without tools or the step budget runs out.
 */
async function driveModel(model, { dir, env, steps, agent, runTool, messages }) {
  const used = [];
  let text = '';
  let refusal = null;
  for (let step = 0; step < steps; step++) {
    let reply;
    try {
      reply = await agent.complete(model, messages, env, [], {});
    } catch (err) {
      // The callers add the route name and the attempt count.
      return { error: oneLine(err?.message || err), used, text, refusal };
    }
    messages.push(reply.assistantMessage);
    if (reply.text) {
      text = reply.text;
      refusal = findRefusal(reply.text) || refusal;
    }
    const calls = reply.toolCalls || [];
    if (!calls.length) break;
    for (const call of calls) {
      used.push(call.name);
      let out;
      try {
        out = await runTool(call.name, call.args || {}, { root: dir, approve: async () => true });
      } catch (err) {
        out = `tool error: ${err?.message || err}`;
      }
      agent.appendToolResult(messages, model, call, out);
    }
  }
  return { used, text, refusal };
}

export async function attemptRoute(model, { dir, env, steps, agent, runTool }) {
  const started = Date.now();
  const token = newToken();
  const messages = [
    { role: 'system', content: agent.SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        'Prove you can run code in this checkout.\n' +
        '1. Run the shell command: node -e "console.log(6*7)"\n' +
        `2. Write a file smoke.txt whose exact content is ${token}\n` +
        'Then reply with the command output and that token on one line.',
    },
  ];

  const run = await driveModel(model, { dir, env, steps, agent, runTool, messages });
  if (run.error) return { status: 'error', ms: Date.now() - started, tools: run.used, note: run.error, reply: '' };
  const { used, text, refusal } = run;

  const file = path.join(dir, 'smoke.txt');
  const wrote = existsSync(file) && readFileSync(file, 'utf8').includes(token);
  const bashRan = used.includes('bash');
  const echoed = String(text).includes(token) || /\b42\b/.test(String(text));
  // A route that runs a command but leaves no file behind has not done the
  // job: a run counted as ok here while smoke.txt was missing (2026-11-22),
  // which is exactly the half-done work this test exists to catch.
  const status = routeStatus({ refusal, bashRan, wrote });
  const note = refusal
    ? refusal
    : `bash=${bashRan ? 'ok' : 'no'}, file=${wrote ? 'ok' : 'no'}, answer=${echoed ? 'ok' : 'off'}`;
  // An empty answer is itself the finding, so it must not print as nothing.
  const reply = oneLine(text).slice(0, 300) || '(empty reply — no text, no tool call)';
  return { status, ms: Date.now() - started, tools: used, note, reply, token };
}

/**
 * The task-mode pass rule: a refusal outranks everything, then talking without
 * a single tool call, then doing work that left the checkout untouched. Only
 * changed files count as done, because that is what --push will commit.
 */
export function taskStatus({ refusal = null, tools = [], changed = [] } = {}) {
  return refusal ? 'refusal' : !tools.length ? 'no-tool' : !changed.length ? 'no-write' : 'ok';
}

/** What the model is told to do with your repo. */
export function taskPrompt(task) {
  return (
    `${String(task).trim()}\n\n` +
    'This is a real checkout of the repository; the workspace root is its top level.\n' +
    'Use the tools: list_dir and read_file to look around, write_file / edit_file / multi_edit / apply_patch to change it, bash to run its tests.\n' +
    'Make the change itself, not a description of it, and leave the checkout with the edit in place.\n' +
    'When you are done, reply with one line naming what you changed.'
  );
}

/**
 * One route, one real task in the checkout: the model writes the change and
 * git is the judge of whether anything actually landed there. Nothing is
 * committed unless main() was given --push.
 */
export async function attemptTask(model, { dir, env, steps, agent, runTool, task }) {
  const started = Date.now();
  const token = newToken();
  const messages = [
    { role: 'system', content: agent.SYSTEM_PROMPT },
    { role: 'user', content: taskPrompt(task) },
  ];
  const run = await driveModel(model, { dir, env, steps, agent, runTool, messages });
  if (run.error) return { status: 'error', ms: Date.now() - started, tools: run.used, note: run.error, reply: '', files: [], token };
  const changes = gitChanges(dir);
  const status = taskStatus({ refusal: run.refusal, tools: run.used, changed: changes });
  const note = run.refusal
    ? run.refusal
    : `${run.used.length} tool call(s), ${changes.length} file(s) changed`;
  const reply = oneLine(run.text).slice(0, 300) || '(empty reply — no text, no tool call)';
  return { status, ms: Date.now() - started, tools: run.used, note, reply, files: changes, token };
}

/**
 * A cold worker answering without a tool call, a refusal, or an upstream
 * error says nothing definitive about the route: volunteer workers rotate,
 * and the first job often lands on one that has not warmed up (seen live —
 * horde/any answered conversationally in 4s, then ran the command in 27s on
 * the next job). One retry on a fresh job and a fresh token, and only then
 * does the route count as broken.
 */
async function smokeRoute(model, ctx) {
  const route = `${model.provider}/${model.id}`;
  const first = await attemptRoute(model, ctx);
  if (first.status === 'ok' || !ctx.retry) return { route, attempts: 1, ...first };
  const second = await attemptRoute(model, ctx);
  return {
    route,
    attempts: 2,
    ...second,
    ms: first.ms + second.ms,
    note: `first attempt ${first.status}; ${second.note}`,
  };
}

/** The same retry rule as smokeRoute, for a real task in the checkout. */
async function taskRoute(model, ctx) {
  const route = `${model.provider}/${model.id}`;
  const first = await attemptTask(model, ctx);
  if (first.status === 'ok' || !ctx.retry) return { route, attempts: 1, ...first };
  // A retry starts from the same checkout, so run git clean first: otherwise
  // attempt one's half-written files would make attempt two look like it wrote.
  execFileSync('git', ['checkout', '--', '.'], { cwd: ctx.dir, stdio: 'ignore' });
  execFileSync('git', ['clean', '-fdq'], { cwd: ctx.dir, stdio: 'ignore' });
  const second = await attemptTask(model, ctx);
  return {
    route,
    attempts: 2,
    ...second,
    ms: first.ms + second.ms,
    note: `first attempt ${first.status}; ${second.note}`,
  };
}

function oneLine(err) {
  return String(err?.message || err).replace(/\s+/g, ' ').trim().slice(0, 220);
}

// Only when run as a script: tests import attemptRoute/routeStatus from here
// and must not clone a repo or call a model on import.
const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  main().catch((err) => {
    console.error(err?.stack || err?.message || err);
    process.exit(1);
  });
}

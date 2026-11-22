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
 * A route fails when it errors, refuses, or never actually drives a tool.
 * Only uncensored-lineage routes run: the list comes from directModels(env)
 * and every entry is re-checked with isUncensoredModel().
 *
 * Usage:
 *   node scripts/live-smoke.mjs                     # every runnable route
 *   node scripts/live-smoke.mjs --route horde/any   # one route
 *   node scripts/live-smoke.mjs --repo jaykk99/termux-code --branch main
 *   node scripts/live-smoke.mjs --json --keep
 *   npm run test:live
 *
 * Keys come from the environment or .env. Exit: 0 all routes passed,
 * 1 a route or the checkout failed, 2 nothing runnable (no keys set).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/* ---------- args ---------- */

function parseArgs(argv) {
  const out = { repo: 'jaykk99/termux-code', branch: null, route: null, steps: 4, retry: true, json: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--keep') out.keep = true;
    else if (a === '--no-retry') out.retry = false;
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--branch') out.branch = argv[++i];
    else if (a === '--route') out.route = argv[++i];
    else if (a === '--steps') out.steps = Math.max(1, Number(argv[++i]) || 4);
    else if (a === '-h' || a === '--help') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return out;
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
function gitEnv() {
  const env = { ...process.env };
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
      try {
        await runTool('write_file', { path: 'smoke-local.txt', content: token }, { root: dir, approve });
        const file = path.join(dir, 'smoke-local.txt');
        result.checkout.writeFile = existsSync(file) && readFileSync(file, 'utf8').includes(token);
      } catch (err) {
        result.checkout.writeFile = false;
        result.checkout.writeError = String(err.message || err);
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
        result.routes.push(
          await smokeRoute(model, { dir, env, steps: args.steps, agent, runTool, retry: args.retry }),
        );
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
        console.log(`${result.routes.filter((r) => r.status === 'ok').length}/${result.routes.length} uncensored routes ran code in the checkout`);
      }
    }

    if (!args.keep) rmSync(dir, { recursive: true, force: true });
    else console.log(`checkout kept at ${dir}`);

    process.exit(result.ok ? 0 : result.repo || args.route ? 1 : 2); // 2 = nothing runnable
  } finally {
    if (!args.keep && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
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
async function attemptRoute(model, { dir, env, steps, agent, runTool }) {
  const started = Date.now();
  const token = newToken();
  const used = [];
  let text = '';
  let refusal = null;
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

  for (let step = 0; step < steps; step++) {
    let reply;
    try {
      reply = await agent.complete(model, messages, env, [], {});
    } catch (err) {
      return { route, status: 'error', ms: Date.now() - started, tools: used, note: oneLine(err?.message || err), reply: '' };
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

  const file = path.join(dir, 'smoke.txt');
  const wrote = existsSync(file) && readFileSync(file, 'utf8').includes(token);
  const bashRan = used.includes('bash');
  const echoed = String(text).includes(token) || /\b42\b/.test(String(text));
  const status = refusal ? 'refusal' : !bashRan ? 'no-tool' : 'ok';
  const note = refusal
    ? refusal
    : `bash=${bashRan ? 'ok' : 'no'}, file=${wrote ? 'ok' : 'no'}, answer=${echoed ? 'ok' : 'off'}`;
  return { status, ms: Date.now() - started, tools: used, note, reply: oneLine(text).slice(0, 300) };
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

function oneLine(err) {
  return String(err?.message || err).replace(/\s+/g, ' ').trim().slice(0, 220);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * termux-code — a coding agent for Termux.
 *
 * Zero runtime dependencies on purpose: no native modules to compile on
 * aarch64, no npm install that dies halfway through on a phone. The UI is
 * raw ANSI (see lib/tui.mjs) rather than ink/blessed for the same reason.
 */

import readline from 'node:readline';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { runTool, run as runCommand } from '../lib/tools.mjs';
import { compactInPlace, needsCompaction, contextChars, SUMMARY_SYSTEM } from '../lib/context.mjs';
import { detectVerifyCommand, wroteFiles, pathsFromCall, exitCodeOf, failureMessage } from '../lib/verify.mjs';
import { isGatewayTool, executeGatewayTool } from '../lib/gateway-tools.mjs';
import { complete, appendToolResult, SYSTEM_PROMPT, sendToErrorInbox } from '../lib/agent.mjs';
import { isGreeting, greetingReply } from '../lib/chatty.mjs';
import { listModels, directModels } from '../lib/models.mjs';
import { FailureTracker, completeWithFailover, FailoverError, chainFailureLines, gatewayFallbackReason, isUncensoredModel, oneLine, renderError } from '../lib/failover.mjs';
import { SessionStore, deriveTitle } from '../lib/sessions.mjs';
import { cleanMessages, trimForGateway } from '../lib/history.mjs';
import { C, box, banner, toolHeader, toolResult, spinner, pick, wrap, width, renderMarkdown } from '../lib/tui.mjs';
import { isRefusalResponse } from '../lib/refusal.mjs';
import { parseArgs, USAGE, approvalModeFor, deniedNote, pickModel, withPlanNote, withDeepNote, stepBudgetFor, subagentStepBudget } from '../lib/cli-args.mjs';
import { connectAll, loadMcpConfig, parseQualified, runMcpTool, toolsForOpenAI as mcpToolsForOpenAI, toolsForAnthropic as mcpToolsForAnthropic } from '../lib/mcp.mjs';
import { addMcpServer, removeMcpServer, formatServerList, parseHeaderArg, testMcpServer, reconnectMcpServers, validateServerName, validateServerUrl } from '../lib/mcp-manager.mjs';
import { projectInstructions, applyProjectInstructions } from '../lib/project-context.mjs';
import { browserDiagnostic } from '../lib/browser.mjs';
import { connectGithubRepo, resolveLocalRepo } from '../lib/repo-connector.mjs';
import { createTaskProgress, observeTaskTool, requestContinuation } from '../lib/task-progress.mjs';
import { effortConfig, effortInstruction, EFFORT_MODES } from '../lib/effort.mjs';
import { AUTOPILOT_DEFAULT_MS, autopilotContinuation, commitMessageFor, detectAutopilotRequest, formatDuration, parseDuration, runAutopilotLoop, withAutopilotNote } from '../lib/autopilot.mjs';
import { commitWorkspace } from '../lib/autocommit.mjs';
import { REASONING_MODES, reasoningPolicy, withReasoningNote } from '../lib/reasoning.mjs';
import { memoryNote, withMemory } from '../lib/frontier.mjs';
import { discoverReconSettings, runReconTool, validateReconUrl, withReconPreflight } from '../lib/recon.mjs';
import { startLocalRecon } from '../lib/recon-service.mjs';
import { runDevice, parseDeviceCommand } from '../lib/device.mjs';

const CONFIG_DIR = path.join(os.homedir(), '.termux-code');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');
const HISTORY_FILE = path.join(CONFIG_DIR, 'history');
/** Tool steps per turn. Peer of the --max-steps flag, so it is mutable. */
let MAX_STEPS = 80;
/** Sent when a budget window ends with the task still open, so the turn
 *  continues instead of handing a half-finished job back to the user. */
const DEEP_CONTINUE =
  'Budget checkpoint: you still had tool work in flight. Say in one line what is done and what is next, then continue the task from where you are. Do not restate the whole plan.';
const MAX_VERIFY_ATTEMPTS = 3;
const VERIFY_TIMEOUT_MS = 180_000;
const HISTORY_KEEP = 200;

/** Providers with no native function calling. They still drive tools
 *  through the text protocol (lib/text-tools.mjs), just less reliably. */
const NO_TOOLS = new Set(['horde', 'hf']);

/* ---------- config ---------- */

async function loadConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function saveConfig(cfg) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await fs.chmod(CONFIG_FILE, 0o600);
}

/**
 * Models come from the Vercel gateway when one is configured — that way your
 * API keys live in Vercel's env, not in plain text on your phone. Falls back
 * to local discovery, then to whatever needs no key at all.
 */
/** The gateway is owner-gated: the phone authenticates with the gateway
 * token minted on the deployment's landing page after GitHub sign-in. */
function gatewayHeaders(cfg) {
  return cfg?.gatewayToken ? { Authorization: `Bearer ${cfg.gatewayToken}` } : {};
}

/**
 * The model a fresh session starts on. Uncensored-only, with no last-resort
 * rung: the old picker ended on `models.find(m => m.free)` and then
 * `models[0]`, either of which could seat an aligned model that reached the
 * catalogue by any path. Here there is nothing to fall back to — no match
 * means no model, and main() says so instead of running an aligned one.
 */
export function defaultModel(models) {
  return (
    // A keyed route beats the volunteer queue. Horde workers are 1B–35B with a
    // 512-token output cap, so seating one while a real uncensored model is
    // configured (OpenRouter, Venice, Naga, DeepInfra — any key in the pool) is
    // the difference between a chat toy and something that can hold a
    // high-level coding task together.
    models.find((m) => m.provider !== 'horde' && isUncensoredModel(m) && (m.auth === 'bearer' || m.auth === 'none')) ||
    models.find((m) => m.provider !== 'horde' && isUncensoredModel(m)) ||
    models.find((m) => m.provider === 'horde' && isUncensoredModel(m)) ||
    models.find((m) => isUncensoredModel(m)) ||
    null
  );
}

async function loadCatalogue(cfg) {
  // Uncensored-only, enforced on the phone too (lib/uncensored.mjs): the
  // gateway's /api/models applies the same filter server-side, but the
  // CLI never trusts a catalogue it is handed — a gateway at any URL
  // could return aligned models, and they must not become pickable or
  // runnable here. Local discovery is filtered at the source already;
  // the extra pass costs nothing.
  const onlyUncensored = (list) => (Array.isArray(list) ? list.filter(isUncensoredModel) : []);
  if (cfg.gateway) {
    try {
      const res = await fetch(cfg.gateway.replace(/\/$/, '') + '/api/models', {
        headers: gatewayHeaders(cfg),
        // A dead gateway must not hold startup hostage; local discovery can proceed.
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) {
        const data = await res.json();
        const models = onlyUncensored(data.models);
        if (models.length) return models;
      }
    } catch {
      /* fall through to local discovery */
    }
  }
  try {
    const local = await listModels();
    if (local.length) return onlyUncensored(local);
  } catch {
    /* ignore */
  }
  return directModels();
}

/* ---------- command history + sessions ---------- */

/**
 * Persistent command history. readline keeps history in-memory only; we load
 * the last HISTORY_KEEP commands on start (most recent last in the file,
 * most recent first in rl.history) and write them back on exit.
 */
async function loadHistory(rl) {
  try {
    const text = await fs.readFile(HISTORY_FILE, 'utf8');
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-HISTORY_KEEP);
    if (Array.isArray(rl.history)) {
      for (const line of lines) rl.history.unshift(line);
      rl.history.length = Math.min(rl.history.length, HISTORY_KEEP);
    }
  } catch {
    /* first run: no history file yet */
  }
}

async function saveHistory(rl) {
  try {
    if (!Array.isArray(rl.history)) return;
    // Do not persist CLI commands containing access codes or API tokens.
    const lines = [...rl.history].reverse()
      .filter((line) => !/^\/(?:recon\s+code\b|bro-code\b|gateway-token\b|inbox-key\b|key\s)/i.test(String(line).trim()))
      .slice(-HISTORY_KEEP);
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(HISTORY_FILE, lines.join('\n') + '\n', { mode: 0o600 });
    await fs.chmod(HISTORY_FILE, 0o600);
  } catch {
    /* history is a nice-to-have; never fail shutdown over it */
  }
}

/** Resume the most recent session with a real conversation, or start fresh. */
async function resumeSession(store) {
  // A just-created empty session (from a /new followed by an immediate
  // quit) used to hijack the next startup and bury the conversation Jay
  // was actually in. Skip empties; fall back to the newest session only
  // when every session is empty.
  const nonEmpty = await store.newestNonEmpty();
  if (nonEmpty) return nonEmpty;
  const sessions = await store.list();
  if (sessions.length) {
    const loaded = await store.load(sessions[0].id);
    if (loaded) return loaded;
  }
  const meta = await store.create('untitled');
  return { meta, messages: [] };
}

function sessionHeadline(session) {
  if (!session.meta.id) {
    return `${C.dim('session')} ${C.amber(session.meta.title)} ${C.dim('/sessions resumes an earlier one')}`;
  }
  const n = session.messages.filter((m) => m.role !== 'system').length;
  return `${C.dim('session')} ${C.amber(session.meta.title)} ${C.dim(`(${n} messages, id ${session.meta.id})`)}`;
}

/* ---------- prompts ---------- */

function ask(rl, question) {
  return new Promise((resolve) => {
    // Ctrl-D / EOF on piped stdin: resolve null so the loop exits cleanly
    // instead of throwing ERR_USE_AFTER_CLOSE.
    if (rl.closed) return resolve(null);
    rl.question(question, (answer) => resolve(answer));
  });
}

/**
 * 'ask' (default, interactive), 'allow' (--yes) or 'deny' (unattended run
 * without --yes: reads still work, writes and shell commands do not).
 */
let approvalMode = 'ask';

/**
 * The approval gate. Shows the change in a box before anything touches disk
 * or the shell, because an agent that edits your phone unsupervised is a
 * different and much worse product.
 */
async function approve(rl, desc, detail) {
  if (approvalMode === 'deny') {
    console.log(C.dim(`  ${deniedNote(desc)}`));
    return false;
  }
  if (approvalMode === 'allow') {
    // Silent on purpose. Every call is approved by default, so a line per
    // call would bury the answer in "auto-approved: ..." noise; the tool
    // header above already shows exactly what ran.
    return true;
  }
  const cols = width() - 6;
  const lines = detail ? wrap(detail, cols).slice(0, 12) : [];
  console.log(
    '\n' +
      box([C.bold(desc), ...(lines.length ? ['', ...lines.map(C.dim)] : [])], {
        title: C.amber('approve'),
        colour: C.amber,
      })
  );
  const raw = await ask(rl, `  ${C.amber('❯')} allow? ${C.dim('[y/N]')} `);
  const answer = (raw ?? '').trim().toLowerCase(); // closed stdin denies
  return answer === 'y' || answer === 'yes';
}

/** Format one model as a picker row. */
function row(m, source) {
  const badges = [];
  if (m.free) badges.push('free');
  if (NO_TOOLS.has(m.provider)) badges.push('text tools');
  if (m.disabled) badges.push('disabled');
  return {
    label: m.label,
    meta: `${m.providerLabel || m.provider} · ${source}`,
    badge: badges.length ? badges.join(' · ') : '',
    disabled: m.disabled,
  };
}

async function chooseModel(models, current, rl) {
  // Group by source so error-inbox's live pool reads separately from the
  // direct provider list, with a header row between them.
  const bySource = models.reduce((a, m) => ((a[m.source] ||= []).push(m), a), {});
  const flat = [];
  const items = [];
  for (const [source, list] of Object.entries(bySource)) {
    for (const m of list) {
      flat.push(m);
      items.push(row(m, source));
    }
  }
  const curIdx = flat.findIndex((m) => m.id === current?.id && m.source === current?.source);
  const chosen = await pick(items, {
    title: `models (${flat.length})`,
    current: curIdx,
    ask: (q) => ask(rl, q),
  });
  return chosen == null ? current : flat[chosen];
}

/* ---------- the loop ---------- */

/**
 * POST a completion turn to the gateway. The gateway holds the provider keys
 * (Vercel env); only this phone runs the tools. Returns the gateway's reply
 * in the same shape local complete() returns: { text, toolCalls, assistantMessage }.
 */
export async function completeViaGateway(gateway, model, messages, gatewayToken, { timeoutMs = 30_000 } = {}) {
  // A ref'd timer, not AbortSignal.timeout: that timer is unref'd, so on a
  // quiet event loop (a stub or a hung socket with nothing else pending) the
  // process can drain before the deadline fires. This object also used to
  // carry two `signal:` keys, so the caller's short deadline was silently
  // replaced by a fixed 50s one.
  const ctl = new AbortController();
  const deadline = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(gateway.replace(/\/$/, '') + '/api/chat', {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {}),
      },
      body: JSON.stringify({ model, messages: trimForGateway(messages) }),
    });
  } finally {
    clearTimeout(deadline);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    // A rejected gateway token is terminal: every model in the chain
    // goes through the same gate, so walking on would just print the
    // same failure twenty times. Say the fix instead.
    const code = data?.error?.code || data?.code;
    if (res.status === 401 || code === 'NO_KEY') {
      const err = new Error(
        'Gateway rejected the token (NO_KEY). Sign in on the site landing page and copy the fresh Termux command, then try again.'
      );
      err.terminal = true;
      throw err;
    }
    throw new Error(data.error ? renderError(data.error) : `Gateway returned HTTP ${res.status}.`);
  }
  // The gateway reply must match local complete()'s shape: turn() pushes
  // reply.assistantMessage into the history, so a missing field poisons
  // every later message with an undefined entry (the gateway then 400s
  // BAD_MESSAGES on all failover attempts). Build it from text when absent.
  if (!data.assistantMessage) {
    data.assistantMessage = { role: 'assistant', content: data.text ?? '' };
  }
  // toolCalls is read with .length by the turn loop; a gateway (or a stub)
  // that answers a plain question without the field used to crash the turn
  // with "Cannot read properties of undefined". Normalise it here, next to
  // the assistantMessage guard that exists for the same reason.
  if (!Array.isArray(data.toolCalls)) data.toolCalls = [];
  return data;
}

/**
 * Walk the failover chain for one assistant step: the chosen model first,
 * then the rest of the catalogue in failover order (keyless tool-capable,
 * then keyed, then chat-only, cooling-down providers last). Failed attempts
 * print one dim line each so a flapping provider is visible, not silent.
 */
export async function runFailoverTurn(model, models, messages, tracker, completeOne, sessionBadModels, opts = {}) {
  const rest = models.filter(
    (m) => !(m.id === model.id && m.provider === model.provider && m.source === model.source)
  );
  const failures = [];
  const { model: winner, reply } = await completeWithFailover([model, ...rest], messages, completeOne, tracker, {
    pinFirst: model,
    sessionBadModels,
    maxAttempts: opts.maxAttempts,
    maxRetryDelayMs: opts.maxRetryDelayMs,
    transientRetries: opts.transientRetries,
    refusalRetry: opts.refusalRetry,
    emptyRetry: opts.emptyRetry,
    onAttempt: (a) => {
      if (a.ok) return;
      failures.push(a);
      if (opts.verbose) {
        console.log(C.dim(`  [chain] ${a.provider} failed (${a.latencyMs}ms): ${oneLine(a.error)}`));
      }
    },
  });
  const moved = winner.id !== model.id || winner.provider !== model.provider;
  // One line, and only when there is something to say: a turn that walked
  // four dead providers and landed on a working one should look like an
  // answer, not like a crash log.
  if (opts.verbose || moved) {
    const bits = [];
    if (failures.length) {
      bits.push(`${failures.length} provider${failures.length > 1 ? 's' : ''} failed`);
    }
    if (moved) bits.push(`answered by ${winner.provider}/${winner.id}`);
    if (bits.length) console.log(C.dim(`  [chain] ${bits.join(', ')}`));
  }
  return reply;
}

/**
 * One user turn: call the model, run the tools it asks for, repeat until
 * it answers without tools. Then, if it changed files and the project has
 * a check command, run the check; a failure goes back to the model as the
 * next message and the loop continues, up to MAX_VERIFY_ATTEMPTS.
 *
 * agent = {
 *   verify: { command, approved, enabled } — session state, mutated here
 *   summarize: (prompt) => Promise<string> — for context compaction
 * }
 */
export async function turn(model, messages, rl, root, completeFn, gateway = {}, agent = {}) {
  const changed = new Set();
  let verifyAttempts = 0;
  let protocolRetries = 0;
  const originalRequest = [...messages].reverse().find(m => m?.role === 'user' && typeof m.content === 'string')?.content || '';
  const progress = createTaskProgress(originalRequest);
  // One budget for the whole turn. The reasoning policy sets the per-mode cap
  // (fast 8, balanced 24, deep 40); --deep / --max-steps raise it, and a run
  // that ends a 40-step window with work still in flight gets up to two
  // automatic extensions instead of stopping to make the user type "continue".
  // A reasoning policy's maxSteps is the cap for the whole turn; a plain
  // agent.maxSteps stays the per-window size it has always been (a caller can
  // still ask for three windows of two). Either way a window is at most 40.
  const policed = Number.isInteger(agent.reasoning?.maxSteps);
  const asked = policed ? agent.reasoning.maxSteps : (agent.maxSteps ?? MAX_STEPS);
  const windowSize = Math.min(asked, 40);
  const maxContinuations =
    agent.autoContinue === false ? 0 : policed ? Math.ceil(asked / windowSize) - 1 : 2;
  const budget = windowSize * (maxContinuations + 1);
  let spent = 0;
  for (let window = 0; window <= maxContinuations && spent < budget; window++) {
    let stillWorking = false;
    for (let step = 0; step < windowSize && spent < budget; step++, spent++) {
    // Plan-first is opt-in, and the note in the system block alone was not
    // enough: a live worker read it, then went straight at the file without
    // writing TODO.md. Put the first step in the ask itself (the last thing
    // the model sees), once per session, so the plan is a tool call rather
    // than a suggestion it can skim past.
    if (step === 0 && agent.think && !agent.planAsked && !existsSync(path.join(root, 'TODO.md'))) {
      agent.planAsked = true;
      messages.push({
        role: 'user',
        content:
          'Before anything else, call write_file to save your plan as TODO.md: a numbered list of at most 5 steps for this task. Then start step 1.',
      });
    }
    // Compact BEFORE the call, so a long session shrinks instead of
    // overflowing a small model's context window.
    if (needsCompaction(messages)) {
      const spinC = spinner('Compacting context');
      const res = await compactInPlace(messages, { summarize: agent.summarize }).catch(() => null);
      spinC.stop();
      if (res) {
        console.log(C.dim(`  [context] compacted ${res.dropped} older messages (${Math.round(res.before / 1000)}k → ${Math.round(res.after / 1000)}k chars${res.usedModel ? ', model summary' : ', digest only'})`));
      }
    }

    // Name the brain answering: on a phone with a volunteer queue behind it,
    // "Thinking" for 40s says nothing, "Thinking · horde/any 40s" says why.
    const who = `${model.provider}/${model.id}`.slice(0, 22);
    const spin = spinner(`${step === 0 ? 'Thinking' : 'Working'} · ${who}`);
    let reply;
    try {
      reply = await completeFn();
      // /trace: the model's own words for this step, before any tool parsing —
      // the closest thing a text worker has to a visible train of thought.
      if (agent.trace) {
        const raw = String(reply?.text ?? '').trim();
        if (raw) console.log(C.grey(`  [trace] ${raw.replace(/\s+/g, ' ').slice(0, 400)}`));
      }
    } catch (err) {
      spin.stop();
      if (err instanceof FailoverError) {
        // A refusal is never echoed, even in the failure box: the attempts
        // log carries the snippets for /verbose, the screen only says that
        // every uncensored route declined.
        const lines = err.refused
          ? [
              `All ${err.attempts.length} uncensored route(s) refused this one.`,
              'Nothing was answered, and no refusal text is shown.',
            ]
          : chainFailureLines(err, { verbose: agent.verbose });
        console.log(
          '\n' +
            box(lines.map((line, i) => (i > 1 ? C.dim(line) : line)), {
              title: C.red(err.refused ? 'refused by every uncensored route' : 'no provider answered'),
              colour: C.red,
            })
        );
        // "empty reply" is what a cold volunteer worker looks like, not a
        // broken setup: say which it is instead of leaving the user to guess.
        console.log(
          C.dim(
            err.refused
              ? '  Every uncensored route declined, so nothing was answered — rephrase it, or /model to pick another brain.\n'
              : /empty reply/i.test(String(err.message))
                ? '  A cold worker answered with nothing — send that again in a moment, or /model to pick another brain.\n'
                : '  Providers cool down for 10 minutes after repeated failures.\n',
          ),
        );
      } else {
        console.log('\n' + box(wrap(oneLine(err.message, 400), width() - 6), { title: C.red('error'), colour: C.red }));
        console.log(C.dim('  /model to switch, or check the key for this provider.\n'));
      }
      return null;
    }
    spin.stop();

    if (reply.text) {
      console.log('\n' + renderMarkdown(reply.text, width() - 2));
    } else if (!reply.toolCalls.length) {
      // A blank turn used to end the message with nothing on screen at all.
      console.log('\n' + C.dim('(empty reply — the model returned nothing; ask again, or /model for a different brain)'));
    }
    messages.push(reply.assistantMessage);

    // A tool call the text protocol could not read — invalid JSON, or a bare
    // object buried in prose: tell the model and let it resend, instead of
    // ending the turn on text nobody can act on. Two asks is the cap; after
    // that the prose is the answer rather than a slow model looping.
    if (!reply.toolCalls.length && reply.textProtocolErrors?.length) {
      if (protocolRetries >= 2) {
        console.log(C.red('  [tools] This model failed to format tool requests after two retries. No action was executed. Use /model-info and choose a native-tool-capable provider with /model.\\n'));
        return null;
      }
      protocolRetries += 1;
      console.log(C.dim(`  [tools] ${reply.textProtocolErrors.length} unwrapped tool request(s); no action executed. Retrying in <tool_call> format (${protocolRetries}/2).`));
      messages.push({
        role: 'user',
        content: `<tool_result name="error">\nThe proposed tool request was NOT executed:\n${reply.textProtocolErrors[0]}\nTo ACT, send ONLY <tool_call>{"name":"list_dir","args":{"path":"."}}</tool_call> (replace the example with the intended known tool and its valid args), then STOP. Do not explain, describe, fence, or simulate the call.\n</tool_result>`,
      });
      stillWorking = true;
      continue;
    }

    if (!reply.toolCalls.length) {
      if (requestContinuation(progress, messages)) {
        console.log(C.dim('  [workflow] Continuing: task has unverified steps.'));
        if (agent.checkpoint) await agent.checkpoint();
        continue;
      }
      // The model thinks it's done. Check its work if it changed anything.
      if (progress.coding && !progress.changed && !progress.inspected && !progress.blocked) {
        console.log(C.red('  [workflow] No project inspection or implementation occurred; task is incomplete.'));
        return null;
      }
      // Every exit below returns the final answer so a one-shot run can
      // report it (and set its exit code); null means the turn failed.
      const v = agent.verify;
      if (!changed.size || !v?.enabled || !v.command) return reply.text ?? '';
      const verifyLimit = agent.reasoning?.maxVerifyAttempts ?? MAX_VERIFY_ATTEMPTS;
      if (verifyAttempts >= verifyLimit) {
        console.log(C.red(`\n  [verify] still failing after ${verifyLimit} fix attempts. Stopping here so you can take a look.`));
        return null;
      }
      if (!v.approved) {
        v.approved = await approve(rl, `Verify changes: run \`${v.command}\` (asked once per session)`, v.command);
        if (!v.approved) {
          v.enabled = false;
          console.log(C.dim('  [verify] off for this session. /verify on to re-enable.'));
          return reply.text ?? '';
        }
      }
      verifyAttempts++;
      console.log('\n' + toolHeader('verify', v.command));
      const spinV = spinner('Checking');
      const output = await runCommand(v.command, root, VERIFY_TIMEOUT_MS);
      spinV.stop();
      if (exitCodeOf(output) === 0) {
        console.log(toolResult(`passed (${v.command})`, { ok: true }));
        return reply.text ?? '';
      }
      console.log(toolResult(output.split('\n').slice(-12).join('\n'), { ok: false }));
      messages.push({ role: 'user', content: failureMessage(v.command, output, verifyAttempts, verifyLimit, changed) });
      stillWorking = true;
      continue;
    }

    for (const call of reply.toolCalls) {
      const arg =
      call.args.path ||
      call.args.command ||
      call.args.pattern ||
      call.args.prompt ||
      call.args.tool_slug ||
      call.args.query ||
      call.args.url ||
      call.args.selector ||
      call.args.action ||
      call.args.from ||
      call.args.subcommand ||
      call.args.text ||
      '';
      console.log('\n' + toolHeader(call.name, arg));
      let result;
      let ok = true;
      try {
        if (call.args && typeof call.args._error === 'string') {
          // The gateway refused oversized arguments; say why, don't run.
          result = call.args._error;
          ok = false;
        } else if (isGatewayTool(call.name)) {
          // Composio tools run server-side through the gateway, where the
          // Composio key lives — never on the phone, which holds no key.
          // A remote app action gets the same yes/no approval as a local
          // write or shell command, because its side effects live outside
          // the phone.
          const preview = JSON.stringify(call.args ?? {}, null, 1).slice(0, 800);
          const allowed = await approve(rl, `Composio → ${call.name}`, preview);
          if (!allowed) {
            result = 'Declined by the user. Ask what they would prefer instead.';
          } else {
            result = await executeGatewayTool({
              gateway: gateway.gateway,
              gatewayToken: gateway.gatewayToken,
              name: call.name,
              args: call.args,
            });
          }
        } else if (parseQualified(call.name)) {
          // A remote MCP tool: approved like any other outbound action, then
          // run through lib/mcp.mjs against the server that owns the name.
          // The servers come through the agent context: turn() is module-level,
          // so it cannot see main()'s local list (it used to throw
          // "mcpServers is not defined" on every MCP call).
          result = await (agent.mcpRunner || runMcpTool)(agent.mcpServers || [], call.name, call.args, (d, detail) => approve(rl, d, detail));
        } else {
          result = await (agent.toolRunner || runTool)(call.name, call.args, {
            root,
            approve: (d, detail) => approve(rl, d, detail),
            // The task tool: a sub-agent with a fresh context (set up in
            // main() and handed in through the agent context — turn() cannot
            // see that local binding itself).
            spawn: agent.spawn,
            // Only the browser tool reads these: its no-Chromium read
            // fallback goes through the gateway, like Composio does.
            gateway: gateway.gateway,
            gatewayToken: gateway.gatewayToken,
            recon: typeof agent.reconSettings === 'function' ? agent.reconSettings() : agent.recon,
            reconActive: typeof agent.isReconActive === 'function' ? agent.isReconActive() : false,
          });
        }
      } catch (err) {
        result = `Error: ${err.message}`;
        ok = false;
      }
      observeTaskTool(progress, call.name, call.args, result);
      if (wroteFiles(call.name, result)) for (const p of pathsFromCall(call)) changed.add(p);
      console.log(toolResult(result, { ok: ok && !/Syntax check failed|JSON syntax error|WARNING:/.test(String(result)) }));
      appendToolResult(messages, model, call, result);
      // A phone can be killed between any two tool calls: persist each completed
      // call + result, not just the beginning/end of the entire user turn.
      if (agent.checkpoint) await agent.checkpoint();
    }
      stillWorking = true;
    }

    // Work was still in flight when the window ran out: keep going. Two
    // extensions is the ceiling, so a looping model still stops.
    if (stillWorking && window < maxContinuations) {
      console.log(C.dim(`  [deep] ${budget * (window + 1)} tool steps used and the task is still open — continuing.`));
      messages.push({ role: 'user', content: DEEP_CONTINUE });
      continue;
    }
    break;
  }
  console.log('\n' + C.red(`Stopped after ${spent} tool steps. Say "continue" to resume.`));
  return null;
}

/* ---------- entry ---------- */

export const HELP = [
  ['/model', 'pick a model for local read/edit/bash work'],
  ['/models', 'list everything reachable, grouped by source'],
  ['/ask <msg>', 'message your Error Inbox agent instead (no file access)'],
  ['/inbox-key <t>', 'save the eibx_... token /ask uses'],
  ['/verbose [on|off]', 'show every provider the failover chain tried'],
  ['/gateway <url>', 'point at a different deployment'],
  ['/gateway off', 'drop the gateway, use keyless direct models'],
  ['/gateway-token <t>', 'save the gateway token minted on the deployment\u2019s landing page'],
  ['/bro <url>', 'point Bro at your gateway (tunnel URL or Render URL)'],
  ['/bro off', 'stop using Bro, fall back to the keyless direct chain'],
  ['/bro-code <c>', 'save the Bro access code (never printed back)'],
  ['/sessions', 'list saved conversation sessions'],
  ['/session <n>', 'resume a session by number or id'],
  ['/new', 'start a new session'],
  ['/think', 'toggle plan-first mode (TODO.md plan, then work the steps)'],
  ['/reasoning [adaptive|fast|balanced|deep]', 'choose execution effort (adaptive by default)'],
  ['/effort <mode>', 'alias for /reasoning: auto, fast, balanced, or deep'],
  ['/deep', 'toggle deep work: acceptance criteria, todo ledger, more steps, auto-continue'],
  ['/loop <time> <goal>', 'autopilot: work toward a goal for up to <time>, then commit'],
  ['/model-info', 'show selected model provenance and verification limits'],
  ['/keys', 'show which provider keys are set'],
  ['/key NAME value', 'save a provider key (VENICE_API_KEY, OPENROUTER_API_KEY, …)'],
  ['/trace', "show the model's own text for each step"],
  ['/rename <t>', 'rename the current session'],
  ['/export [file]', 'export the session as Markdown'],
  ['/failover', 'show provider failover status'],
  ['/verify [on|off|<cmd>]', 'auto-check changes with the project\u2019s tests'],
  ['/compact', 'summarize older context now'],
  ['/context', 'show how much context the session uses'],
  ['/clear', 'forget this conversation'],
  ['/map', 'summarize this project: stack, files, entry points, scripts'],
  ['/undo [id]', 'restore the newest checkpoint (or a named one)'],
  ['/cwd', 'show the workspace root'],
  ['/repo <owner/repo|path>', 'connect to a GitHub or local repository workspace'],
  ['/mcp', 'list configured MCP servers and their live status'],
  ['/mcp add <name> <url> ["Header: value"]', 'save an MCP server and connect it now'],
  ['/mcp test <name>', 'check one MCP server and list its tools'],
  ['/mcp remove <name>', 'remove an MCP server from the saved config'],
  ['/mcp reload', 'reconnect every configured MCP server'],
  ['/recon', 'check the ReconAnything scanner connection'],
  ['/recon start', 'launch an installed local ReconAnything scanner'],
  ['/recon url <url>', 'set the local/LAN ReconAnything backend URL'],
  ['/recon code <code>', 'save the ReconAnything owner access code'],
  ['/recon active on', 'explicitly permit active scans for this session'],
  ['/browser', 'check browser access, Chromium and gateway fallback'],
  ['/device', 'inspect Android/Termux:API command availability and permission setup'],
  ['/device battery', 'read battery; direct commands also work without LLM tools'],
  ['/device torch on|off', 'toggle flashlight with on-phone confirmation'],
  ['/exit', 'quit'],
];

/** Version comes from package.json so there is one place to bump it. */
async function versionString() {
  try {
    const pkg = JSON.parse(
      await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')
    );
    return `termux-code ${pkg.version}`;
  } catch {
    return 'termux-code (version unavailable: package.json not readable)';
  }
}

/**
 * Read a piped prompt: `echo "fix the build" | termux-code`, or
 * `cat spec.md | termux-code`. Returns null when stdin is a terminal.
 */
async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text || null;
}

/** Stand-in for readline in one-shot mode: nothing ever prompts. */
function quietIo() {
  return {
    closed: false,
    question: (_q, cb) => cb(''),
    close() {},
  };
}

async function main(workspaceOverride = null) {
  // ---- command line --------------------------------------------------
  // Before this, the CLI ignored argv entirely: `--help` and `--version`
  // started a full session and printed the banner instead.
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(C.red(`termux-code: ${args.error}`));
    console.error(C.dim('  termux-code --help for the usage'));
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.version) {
    console.log(await versionString());
    return;
  }
  if (workspaceOverride || args.cwd) {
    try {
      process.chdir(workspaceOverride || args.cwd);
    } catch (err) {
      console.error(C.red(`termux-code: cannot use ${args.cwd}: ${err.message}`));
      process.exitCode = 2;
      return;
    }
  }
  approvalMode = approvalModeFor(args);
  MAX_STEPS = stepBudgetFor(args);

  // A piped prompt counts as one-shot too, and one-shot without --yes
  // only reads: an unattended run must not edit the phone.
  let prompt = args.prompt;
  if (!prompt) {
    const piped = await readStdin();
    if (piped) {
      prompt = piped;
      approvalMode = approvalModeFor({ ...args, prompt });
    }
  }
  const oneShot = Boolean(prompt);
  if (args.autopilot && !oneShot) {
    console.error(C.red('termux-code: --autopilot and --for need an objective.'));
    console.error(C.dim('  termux-code --for 45m "fix the failing tests"'));
    process.exitCode = 2;
    return;
  }

  const root = process.cwd();
  const cfg = await loadConfig();
  let reconActive = false; // session-only: active scanning must be explicitly enabled
  const currentRecon = () => discoverReconSettings(cfg);

  // Bro (Jay's uncensored gateway) comes from ~/.termux-code/config.json
  // — set by the installer (TERMUX_CODE_BRO_URL / TERMUX_CODE_BRO_CODE)
  // or by /bro and /bro-code inside the CLI — and feeds the same env
  // vars the provider registry reads (BRO_BASE_URL, BRO_ACCESS_CODE).
  // A real env var always wins over the config file, and the code is
  // never printed anywhere: /bro-code with no argument only says
  // whether one is set.
  if (cfg.broBaseUrl && !process.env.BRO_BASE_URL) process.env.BRO_BASE_URL = cfg.broBaseUrl;
  if (cfg.broAccessCode && !process.env.BRO_ACCESS_CODE) process.env.BRO_ACCESS_CODE = cfg.broAccessCode;
  // Keys saved with /key live in config.json and are applied before the
  // catalogue loads, so a pasted key switches its provider on in the same
  // session. A real environment variable always wins over the file.
  for (const [name, value] of Object.entries(cfg.keys || {})) {
    if (typeof value === 'string' && value && !process.env[name]) process.env[name] = value;
  }

  // MCP servers: a project's .mcp.json plus mcpServers in the CLI config,
  // each { url, headers? }. Connected once at startup; a server that is down
  // is named once and skipped rather than stopping the CLI.
  const mcpConfig = await loadMcpConfig(root, cfg.mcpServers).catch(() => ({}));
  const mcpServers = Object.keys(mcpConfig).length ? await connectAll(mcpConfig).catch(() => []) : [];
  // `let`, not `const`: /mcp add/remove/reload rebuilds these in place so
  // the next turn — and the sub-agent runner, which holds the same array
  // reference — sees the new servers without a restart.
  let mcpLive = mcpServers.filter((s) => s.ready);
  let mcpToolsOAI = mcpToolsForOpenAI(mcpLive);
  let mcpToolsAnthropic = mcpToolsForAnthropic(mcpLive);
  const rebuildMcpTools = () => {
    mcpLive = mcpServers.filter((s) => s.ready);
    mcpToolsOAI = mcpToolsForOpenAI(mcpLive);
    mcpToolsAnthropic = mcpToolsForAnthropic(mcpLive);
  };
  /** Reconnect every configured server, replacing the live array in place. */
  const refreshMcpLive = async (config) => {
    const fresh = await reconnectMcpServers(config).catch(() => []);
    mcpServers.splice(0, mcpServers.length, ...fresh);
    rebuildMcpTools();
    return fresh;
  };
  if (mcpServers.length && !(args.json && oneShot)) {
    console.log(
      mcpLive.length
        ? C.dim(`  [mcp] ${mcpLive.map((s) => `${s.name} (${s.tools.length} tools)`).join(', ')}\n`)
        : C.red(`  [mcp] no server connected: ${mcpServers.map((s) => `${s.name}: ${s.error}`).join('; ')}\n`)
    );
  }

  const boot = spinner('Loading models');
  let models = await loadCatalogue(cfg);
  boot.stop();

  let model =
    // A saved /model choice wins, but only while it is still uncensored: a
    // config written before the policy tightened (or by hand) must not keep
    // an aligned model in the seat.
    models.find((m) => m.id === cfg.modelId && m.source === cfg.modelSource && isUncensoredModel(m)) ||
    defaultModel(models);

  // --model wins over the saved /model choice when it names something real;
  // a typo must fail loudly instead of quietly running on another model.
  if (args.model) {
    const chosen = pickModel(models, args.model);
    if (!chosen) {
      console.error(
        C.red(`termux-code: no model matches ${JSON.stringify(args.model)}.`) +
          C.dim(' Run /models inside the REPL to see the catalogue.')
      );
      process.exitCode = 2;
      return;
    }
    model = chosen;
  }

  if (!model) {
    console.log(
      box(
        wrap(
          'No uncensored models are reachable. AI Horde needs no key at all, so this usually means no network, or no uncensored worker is online right now. Set a gateway with /gateway once you have one.',
          width() - 6
        ),
        { title: C.red('no models'), colour: C.red }
      )
    );
    return;
  }

  const rl = oneShot
    ? quietIo()
    : readline.createInterface({ input: process.stdin, output: process.stdout });
  if (!oneShot) await loadHistory(rl);

  const store = new SessionStore(SESSIONS_DIR);
  const tracker = new FailureTracker();
  // Models a provider rejected as unknown (BAD_MODEL) this session.
  // completeWithFailover adds to this set on each rejection and skips
  // its entries without spending a call, so one stale model id costs
  // exactly one fast failure per session instead of one per turn.
  const sessionBadModels = new Set();
  // One-shot runs are ephemeral unless --session names a saved one: a
  // script that runs fifty prompts must not fill the session list.
  let session;
  if (oneShot) {
    session = args.session
      ? (await store.load(args.session)) || (await store.create('untitled'))
      : { meta: { id: null, title: 'untitled' }, messages: [] };
  } else if (args.resume) {
    session = await resumeSession(store);
  } else {
    // Fresh conversation by default. Resuming the newest session on every
    // start appended a new prompt to the previous task, so the agent kept
    // working on that task instead of the new one ("stuck on previous
    // tasks"). Continuing one is explicit now: --resume, or /sessions.
    session = { meta: { id: null, title: 'untitled' }, messages: [] };
  }
  // Sessions saved before the gateway-shape fix can carry poisoned entries
  // (an undefined assistant message serialized as null); drop them here so
  // a poisoned session self-heals instead of failing every later message.
  const cleanedSession = cleanMessages(session.messages);
  const messages = cleanedSession.length
    ? cleanedSession
    : [{ role: 'system', content: SYSTEM_PROMPT }];
  // Always use the active workspace's memory, not stale system instructions
  // embedded in an older session from another working directory.
  const projectNote = await projectInstructions(root);
  const refreshProjectContext = () =>
    applyProjectInstructions(messages, withPlanNote(SYSTEM_PROMPT, state?.think || false), projectNote);

  // Project memory (the `remember` tool) rides on the system prompt, so every
  // turn of the session sees the facts Jay asked to keep. withMemory strips
  // any earlier copy first, so resuming a session cannot duplicate it.
  const memory = await memoryNote(root);
  if (memory) {
    if (messages[0]?.role === 'system') {
      messages[0] = { ...messages[0], content: withMemory(messages[0].content, memory) };
    } else {
      messages.unshift({ role: 'system', content: withMemory(SYSTEM_PROMPT, memory) });
    }
  }

  /** Persist the conversation without ever breaking the loop. A failed
   *  save is no longer silent: if the phone can't write, Jay should know
   *  his turns may not survive a restart. */
  const persist = async () => {
    // A fresh session has no id until it says something: create it on the
    // first real turn, so a launch that never speaks leaves no empty session
    // behind and /sessions only lists conversations that happened.
    if (!session.meta.id && !oneShot) {
      try {
        session = { ...session, meta: await store.create('untitled') };
      } catch {
        /* keep chatting; the save below reports the failure */
      }
    }
    if (!session.meta.id) return; // one-shot without --session: nothing to save
    try {
      if (session.meta.title === 'untitled') {
        const title = deriveTitle(messages, 'untitled');
        if (title !== 'untitled') session.meta = await store.rename(session.meta.id, title);
      }
      session.meta = await store.save(session.meta.id, messages);
    } catch (err) {
      console.log(C.dim(`  [sessions] could not save this turn (${err?.message || err}); chatting continues, but a restart may lose it.\n`));
    }
  };

  /**
   * Session-level switches that the REPL can change at runtime. Quiet is
   * the default: a failed provider is a detail, not news.
   */
  // One setting, two names: /reasoning picks the mode, /effort is its alias.
  // The mode drives the per-turn policy (step and verify budgets) and, through
  // state.turnEffort, the failover/timeout effort the model call sees. Deep
  // work pins the mode to deep and raises the cap to the --deep budget.
  const state = {
    verbose: Boolean(args.verbose),
    think: Boolean(args.think),
    deep: Boolean(args.deep),
    reasoning: args.reasoning ?? (REASONING_MODES.includes(cfg.reasoning) ? cfg.reasoning : 'adaptive'),
    turnEffort: 'fast',
  };
  const prepareReasoning = async (text, transcript = messages) => {
    const policy = reasoningPolicy(text, state.deep ? 'deep' : state.reasoning, MAX_STEPS);
    if (state.deep) policy.maxSteps = MAX_STEPS;
    state.turnEffort = policy.effort;
    if (transcript[0]?.role === 'system') {
      // Security work gets a real health result before the model speaks, so a
      // "here's how to access it legally" menu can no longer stand in for it.
      transcript[0] = {
        ...transcript[0],
        content: await withReconPreflight(
          withReasoningNote(transcript[0].content, policy.effort),
          text,
          { recon: currentRecon(), reconActive },
          // Shown regardless of what the model does with the note.
          (result) => console.log(C.dim(`  [recon] ${oneLine(result, 160)}`))
        ),
      };
    }
    return policy;
  };
  refreshProjectContext();
  // Plan-first: the note rides on the system prompt, so every turn of the
  // session sees it — including the tool results the model reads back.
  if (state.think && messages[0]?.role === 'system') {
    messages[0] = { ...messages[0], content: withPlanNote(messages[0].content, true) };
  }
  // Deep work rides on the system prompt for the same reason the plan note
  // does: every step of every turn sees it, including tool results.
  if (state.deep && messages[0]?.role === 'system') {
    messages[0] = { ...messages[0], content: withDeepNote(messages[0].content, true) };
  }

  /**
   * One assistant step over an arbitrary message list, through the
   * gateway when one is configured, else direct. Both modes walk the
   * failover chain: the chosen model first, then the rest of the
   * catalogue when it fails OR refuses (see lib/refusal.mjs). If the
   * gateway path fails — a terminal token rejection, or every provider
   * failing THROUGH the gateway — fall back to the keyless direct chain
   * for the rest of the session. Sign-in is never required to keep
   * chatting; a fresh session retries the gateway.
   */
  const completeFor = async (msgs) => {
    const effort = state.think ? 'deep' : state.turnEffort;
    const chainOpts = { verbose: state.verbose, ...effortConfig(effort) };
    const prepareMessages = (source) => source.map((msg, i) => i === 0 && msg?.role === 'system'
      ? { ...msg, content: String(msg.content || '') + '\n\n' + effortInstruction(effort) }
      : msg);
    const gatewayTurn = () => runFailoverTurn(model, models, msgs, tracker, (m, context) => completeViaGateway(cfg.gateway, m, prepareMessages(context), cfg.gatewayToken, { timeoutMs: effort === 'fast' ? 12_000 : effort === 'balanced' ? 25_000 : 45_000 }), sessionBadModels, chainOpts);
    // MCP tools are passed in the shape the model's wire format expects; the
    // gateway path gets none because the gateway has its own tool list.
    const directTurn = () =>
      runFailoverTurn(
        model,
        models,
        msgs,
        tracker,
        (m, context) => complete(m, prepareMessages(context), process.env, m.auth === 'anthropic' ? mcpToolsAnthropic : mcpToolsOAI, { effort }),
        sessionBadModels,
        chainOpts
      );
    if (!cfg.gateway || gatewayDead) return directTurn();
    try {
      return await gatewayTurn();
    } catch (err) {
      const reason = gatewayFallbackReason(err);
      if (reason) {
        gatewayDead = true;
        console.log(C.dim(reason === 'terminal'
          ? '  [gateway] token rejected, falling back to keyless direct models. /gateway-token <t> to re-enable the gateway.\n'
          : '  [gateway] all providers failed through the gateway, falling back to keyless direct models.\n'));
        return directTurn();
      }
      throw err;
    }
  };

  /** Model-written summary for context compaction (lib/context.mjs). */
  const summarize = async (prompt) => {
    const reply = await completeFor([
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: prompt },
    ]);
    return reply.toolCalls?.length ? '' : reply.text;
  };

  /** Verify-step state for this session (lib/verify.mjs). cfg.verify is
   *  'auto' (default: detect from the project), 'off', or a command. */
  const verifyState = {
    command: cfg.verify && cfg.verify !== 'auto' && cfg.verify !== 'off' ? cfg.verify : await detectVerifyCommand(root),
    enabled: cfg.verify !== 'off',
    approved: false,
  };

  if (!oneShot) {
    console.log(
      banner({
        cwd: path.basename(root),
        model: model.label,
        source: model.source,
        free: model.free,
      })
    );
    console.log('  ' + sessionHeadline(session));
    console.log(C.dim('  say what you want — "fix the failing test", "what does this repo do?"'));
    console.log(C.dim('  /help for commands · /sessions resumes an old chat · ctrl-c to quit\n'));
  }

  // Once the gateway path fails (token rejected, or every provider failed
  // through it), stay on keyless direct models for the rest of the
  // session; a fresh /gateway-token re-enables the gateway.
  let gatewayDead = false;

  /**
   * A sub-agent: the `task` tool, run in a fresh context with its own step
   * budget, so a long side quest (read this repo, find X, draft Y) does not
   * fill the main conversation with its transcript. It reports back in text;
   * the main session decides what to do with that.
   */
  const runSubagent = async (taskPrompt, extraContext = '') => {
    const sub = [
      {
        role: 'system',
        content:
          SYSTEM_PROMPT +
          '\n\n## Sub-agent\nYou are a sub-agent working for the main session. Do exactly this one task, do not ask questions, and finish with a short report: what you did, what you found, and anything left undone.',
      },
      { role: 'user', content: extraContext ? `${taskPrompt}\n\n[context]\n${extraContext}` : taskPrompt },
    ];
    const out = await turn(
      model,
      sub,
      rl,
      root,
      () => completeFor(sub),
      { gateway: cfg.gateway, gatewayToken: cfg.gatewayToken },
      // No spawn: a sub-agent must not start another one, or a misbehaving
      // model can nest tasks until the step budget is the only limit.
      // Its own budget, not 8: a delegated "read this, then check that URL"
      // needs room, and it never runs longer than the main loop would.
      {
        verify: { ...verifyState, enabled: false },
        summarize,
        verbose: false,
        trace: state.trace,
        mcpServers,
        reconSettings: currentRecon,
        isReconActive: () => reconActive,
        deep: state.deep,
        maxSteps: subagentStepBudget({ deep: state.deep, parent: MAX_STEPS }),
        autoContinue: false,
      }
    );
    const report = typeof out === 'string' ? out : String(out?.text ?? '');
    return report.trim().slice(0, 4000) || 'The sub-agent returned nothing.';
  };

  /**
   * Commit the workspace after a long run. Local only — never a push — and a
   * --ask one-shot (read-only by construction) declines it like any other
   * write. Reports the real git result instead of claiming success.
   */
  const tryCommit = async (objective) => {
    const message = commitMessageFor(objective);
    if (approvalMode === 'deny') {
      console.log(C.dim('\n  [commit] skipped: this --ask one-shot run is read-only.'));
      return { committed: false, reason: 'read-only' };
    }

    console.log('\n' + toolHeader('commit', message));
    const result = commitWorkspace(root, { message });
    if (result.committed) {
      console.log(toolResult(`committed ${result.sha || '(sha unavailable)'} · ${result.files.length} path(s)`, { ok: true }));
      for (const line of result.files.slice(0, 8)) console.log(C.dim(`  ${line}`));
      if (result.files.length > 8) console.log(C.dim(`  … +${result.files.length - 8} more`));
    } else if (result.reason === 'clean') {
      console.log(C.dim('  [commit] nothing to commit: the workspace is already clean.'));
    } else if (result.reason === 'not-a-repo') {
      console.log(C.dim('  [commit] skipped: not a git repository.'));
    } else {
      console.log(C.red(`  [commit] failed: ${oneLine(result.detail || 'git commit failed', 300)}`));
    }
    return result;
  };

  /**
   * Autopilot: one objective, many turns, a wall-clock budget, and an explicit
   * stop marker. Each cycle is one bounded turn (40 tool steps, no inner
   * continuation windows), so the budget is checked at useful intervals and
   * completed work is persisted between cycles. This is the outer loop
   * OpenClaw-style long tasks need; turn() already owns the inner one.
   */
  const runAutopilot = async (objective, budgetMs) => {
    if (messages[0]?.role === 'system') {
      messages[0] = { ...messages[0], content: withAutopilotNote(messages[0].content, true) };
    }
    // Autopilot is deep work by definition. Pin it for the run, then restore
    // the session setting so a REPL /loop does not turn every later chat deep.
    const previousDeep = state.deep;
    state.deep = true;
    const reasoning = await prepareReasoning(objective);
    console.log(C.dim(`  [autopilot] goal: ${oneLine(objective, 160)}`));
    console.log(C.dim(`  [autopilot] budget ${formatDuration(budgetMs)} · TASK COMPLETE or BLOCKED ends it early`));
    try {
      const result = await runAutopilotLoop({
        budgetMs,
        runCycle: async ({ cycle, remainingMs }) => {
          if (cycle > 1) {
            console.log(C.dim(`\n  [autopilot] cycle ${cycle} · ${formatDuration(remainingMs)} left`));
            messages.push({ role: 'user', content: autopilotContinuation({ cycle, remainingMs }) });
          }
          const before = messages.length;
          let cycleAnswer = null;
          try {
            cycleAnswer = await turn(model, messages, rl, root, () => completeFor(messages), {
              gateway: cfg.gateway,
              gatewayToken: cfg.gatewayToken,
            }, {
              verify: verifyState,
              summarize,
              verbose: state.verbose,
              trace: state.trace,
              think: state.think,
              deep: true,
              mcpServers,
              reconSettings: currentRecon,
              isReconActive: () => reconActive,
              spawn: runSubagent,
              checkpoint: persist,
              reasoning,
              autoContinue: false,
            });
          } catch (err) {
            console.log(C.red(`  [autopilot] cycle ${cycle} failed: ${oneLine(err?.message || err, 240)}`));
          }
          await persist();
          return {
            answer: typeof cycleAnswer === 'string' ? cycleAnswer : null,
            progressed: messages.length > before,
          };
        },
      });
      const labels = {
        complete: 'goal complete',
        budget: 'time budget reached — work is left undone',
        blocked: `blocked: ${result.blocked}`,
        stalled: 'stopped: the last cycle made no progress',
        'cycle-limit': `stopped after ${result.cycles.length} cycles`,
        error: `stopped on an error: ${oneLine(result.error?.message || result.error, 200)}`,
      };
      console.log(
        C.dim(
          `\n  [autopilot] ${labels[result.reason] || result.reason} · ${result.cycles.length} cycle(s) · ${formatDuration(
            result.endedAt - result.startedAt
          )}`
        )
      );
      return { ...result, reasoning };
    } finally {
      state.deep = previousDeep;
      // The goal note belongs to this run, not to the next user message in
      // the same REPL session.
      if (messages[0]?.role === 'system') {
        messages[0] = { ...messages[0], content: withAutopilotNote(messages[0].content, false) };
      }
    }
  };

  /** Start an autopilot run from the REPL, then commit it when it ends. */
  const startAutopilot = async (objective, budgetMs) => {
    messages.push({ role: 'user', content: objective });
    await persist();
    const run = await runAutopilot(objective, budgetMs);
    await persist();
    if (!args.noCommit && typeof run.lastAnswer === 'string' && (run.complete || run.reason === 'budget')) {
      await tryCommit(objective);
    }
    return run;
  };

  // One prompt, no REPL. Exit 0 only when the turn actually produced an
  // answer, so `termux-code -p ...` is usable from a script.
  if (oneShot) {
    const realLog = console.log;
    let answer = null;
    let autopilot = null;
    let commit = null;
    let reasoning;
    messages.push({ role: 'user', content: prompt });
    await persist();
    if (args.json) console.log = (...a) => console.error(...a); // keep stdout clean
    try {
      if (args.autopilot) {
        autopilot = await runAutopilot(prompt, args.forMs ?? AUTOPILOT_DEFAULT_MS);
        reasoning = autopilot.reasoning;
        answer = autopilot.lastAnswer;
        // A run that used its whole budget still produced reviewable work;
        // a blocked or stalled one did not reach a state worth committing.
        if (
          !args.noCommit &&
          typeof answer === 'string' &&
          (autopilot.complete || autopilot.reason === 'budget')
        ) {
          commit = await tryCommit(prompt);
        }
      } else {
        reasoning = await prepareReasoning(prompt);
        answer = await turn(model, messages, rl, root, () => completeFor(messages), {
          gateway: cfg.gateway,
          gatewayToken: cfg.gatewayToken,
        }, { verify: verifyState, summarize, verbose: args.verbose || state.verbose, trace: state.trace, think: state.think, deep: state.deep, mcpServers, reconSettings: currentRecon, isReconActive: () => reconActive, spawn: runSubagent, checkpoint: persist, reasoning });
        if (args.commit && !args.noCommit && typeof answer === 'string') commit = await tryCommit(prompt);
      }
    } finally {
      console.log = realLog;
    }
    await persist();
    if (args.json) {
      const ok = typeof answer === 'string';
      realLog(
        JSON.stringify({
          ok,
          answer: ok ? answer : null,
          model: model.id,
          provider: model.provider,
          source: model.source,
          steps: reasoning.maxSteps,
          reasoning: reasoning.effort,
          savedSession: session.meta.id || null,
          autopilot: autopilot
            ? {
                reason: autopilot.reason,
                complete: autopilot.complete,
                blocked: autopilot.blocked,
                cycles: autopilot.cycles.length,
                budgetMs: autopilot.budgetMs,
                elapsedMs: autopilot.endedAt - autopilot.startedAt,
              }
            : null,
          commit: commit
            ? {
                committed: Boolean(commit.committed),
                sha: commit.sha || null,
                reason: commit.reason || null,
                files: Array.isArray(commit.files) ? commit.files.length : 0,
              }
            : null,
        })
      );
    }
    if (typeof answer !== 'string') process.exitCode = 1;
    if (rl.close) rl.close();
    return;
  }

  for (;;) {
    const raw = await ask(rl, `${C.amber('❯')} `);
    if (raw === null) break; // stdin closed (Ctrl-D / piped EOF)
    const input = raw.trim();
    if (!input) continue;
    if (input === '/exit' || input === '/quit') break;

    if (input === '/help') {
      console.log(
        '\n' +
          box(
            HELP.map(([cmd, desc]) => `${C.amber(cmd.padEnd(15))} ${C.dim(desc)}`),
            { title: 'commands' }
          ) +
          '\n'
      );
      continue;
    }

    if (input === '/reasoning' || input.startsWith('/reasoning ')) {
      const choice = input.slice('/reasoning'.length).trim().toLowerCase();
      if (!choice) {
        console.log(C.dim(`  reasoning: ${state.reasoning} (adaptive chooses fast/balanced/deep per prompt)\n`));
      } else if (!REASONING_MODES.includes(choice)) {
        console.log(C.dim('  Usage: /reasoning adaptive|fast|balanced|deep\n'));
      } else {
        state.reasoning = choice;
        cfg.reasoning = choice;
        await saveConfig(cfg);
        console.log(C.dim(`  reasoning set to ${choice}\n`));
      }
      continue;
    }

    if (input === '/model') {
      const next = await chooseModel(models, model, rl);
      if (next && next !== model) {
        model = next;
        await saveConfig({ ...cfg, modelId: model.id, modelSource: model.source });
      }
      const note = NO_TOOLS.has(model.provider)
        ? C.dim(' — tools via text protocol (experimental; model may ignore calls)')
        : '';
      console.log(`${C.amber('⏺')} ${model.label}${note}\n`);
      continue;
    }

    if (input === '/models') {
      const bySource = models.reduce((a, m) => ((a[m.source] ||= []).push(m), a), {});
      const lines = [];
      for (const [source, list] of Object.entries(bySource)) {
        lines.push(C.bold(source) + C.dim(` (${list.length})`));
        for (const m of list.slice(0, 24)) {
          lines.push(`  ${m.free ? C.green('·') : C.grey('·')} ${m.label}`);
        }
        if (list.length > 24) lines.push(C.dim(`  … +${list.length - 24} more`));
        lines.push('');
      }
      console.log('\n' + box(lines.slice(0, -1), { title: 'models' }) + '\n');
      continue;
    }

    if (input.startsWith('/ask ')) {
      const message = input.slice(5).trim();
      if (!message) continue;
      const spin = spinner('Asking your agent');
      try {
        const reply = await sendToErrorInbox(message, {
          baseUrl: cfg.errorInboxUrl,
          apiKey: cfg.errorInboxKey,
        });
        spin.stop();
        console.log('\n' + toolHeader('error-inbox', 'agent'));
        // /ask goes to error-inbox's own agent, whose model is not ours to
        // pick — but a refusal still must not be shown as the answer.
        console.log(
          isRefusalResponse(reply)
            ? C.dim('  That agent declined the request; nothing was answered. (No refusal text is shown.)\n')
            : renderMarkdown(reply, width() - 2) + '\n',
        );
      } catch (err) {
        spin.stop();
        console.log('\n' + box(wrap(err.message, width() - 6), { title: C.red('error'), colour: C.red }) + '\n');
      }
      continue;
    }

    if (input.startsWith('/gateway-token')) {
      const token = input.slice(14).trim();
      if (!token) {
        console.log(
          C.dim('  ' + (cfg.gatewayToken ? 'A gateway token is set.' : 'No gateway token set. Mint one on the deployment\u2019s landing page after signing in.')) + '\n'
        );
        continue;
      }
      cfg.gatewayToken = token;
      gatewayDead = false;
      await saveConfig(cfg);
      console.log(C.dim('  Saved. The gateway will now accept this phone as you.\n'));
      continue;
    }

    if (input.startsWith('/gateway')) {
      const url = input.slice(8).trim();
      if (!url) {
        console.log(C.dim('  ' + (cfg.gateway || 'No gateway set.')) + '\n');
        continue;
      }
      if (url === 'off') {
        delete cfg.gateway;
        delete cfg.gatewayToken;
        gatewayDead = false;
        await saveConfig(cfg);
        console.log(C.dim('  Gateway cleared. Keyless direct models only. Restart to reload the model list.\n'));
        continue;
      }
      cfg.gateway = url;
      gatewayDead = false;
      await saveConfig(cfg);
      console.log(C.dim('  Saved. Restart to reload the model list.\n'));
      continue;
    }

    if (input.startsWith('/bro-code')) {
      const code = input.slice(9).trim();
      if (!code) {
        console.log(
          C.dim('  ' + (cfg.broAccessCode || process.env.BRO_ACCESS_CODE ? 'A Bro access code is set.' : 'No Bro access code set. The gateway does not require one today.')) + '\n'
        );
        continue;
      }
      cfg.broAccessCode = code;
      process.env.BRO_ACCESS_CODE = code;
      await saveConfig(cfg);
      console.log(C.dim('  Saved. Restart to use it.\\n'));
      continue;
    }

    if (input.startsWith('/bro')) {
      const url = input.slice(4).trim();
      if (!url) {
        console.log(C.dim('  ' + (cfg.broBaseUrl || process.env.BRO_BASE_URL || 'No Bro gateway set.')) + '\n');
        continue;
      }
      if (url === 'off') {
        delete cfg.broBaseUrl;
        delete cfg.broAccessCode;
        delete process.env.BRO_BASE_URL;
        delete process.env.BRO_ACCESS_CODE;
        await saveConfig(cfg);
        console.log(C.dim('  Bro cleared. Horde and the keyless direct chain are the fallback. Restart to reload the model list.\\n'));
        continue;
      }
      cfg.broBaseUrl = url;
      process.env.BRO_BASE_URL = url;
      await saveConfig(cfg);
      console.log(C.dim('  Saved. Bro is tried first from the next restart.\\n'));
      continue;
    }

    if (input.startsWith('/inbox-key')) {
      const token = input.slice(10).trim();
      if (!token) {
        console.log(
          C.dim('  ' + (cfg.errorInboxKey ? 'A key is set.' : 'No key set. Mint one on Error Inbox → Settings.')) + '\n'
        );
        continue;
      }
      cfg.errorInboxKey = token;
      await saveConfig(cfg);
      console.log(C.dim('  Saved. /ask will use it.\n'));
      continue;
    }

    if (input === '/clear') {
      messages.length = 0;
      messages.push({ role: 'system', content: withPlanNote(SYSTEM_PROMPT, state.think) });
      refreshProjectContext();
      await persist();
      console.log(C.dim('  Conversation cleared.\n'));
      continue;
    }

    if (input === '/trace') {
      state.trace = !state.trace;
      console.log(
        C.dim(
          state.trace
            ? '  trace on — every step prints the model\u2019s own text before tool calls.\n'
            : '  trace off.\n'
        )
      );
      continue;
    }

    if (input === '/keys') {
      const known = ['VENICE_API_KEY', 'OPENROUTER_API_KEY', 'NAGA_API_KEY', 'DEEPINFRA_API_KEY', 'GRATISFY_API_KEY', 'LLM7_API_KEY', 'AIHORDE_API_KEY', 'HF_TOKEN', 'ERROR_INBOX_KEY'];
      const lines = known.map((n) => `${process.env[n] ? C.green('set  ') : C.grey('unset')} ${n}`);
      console.log(
        '\n' +
          box([...lines, '', C.dim('/key NAME value saves one (plain text in ~/.termux-code/config.json)')], { title: 'provider keys' }) +
          '\n'
      );
      continue;
    }

    if (input.startsWith('/key ')) {
      const [, name, ...rest] = input.split(/\s+/);
      const value = rest.join(' ').trim();
      if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(name || '') || !value) {
        console.log(C.dim('  Usage: /key OPENROUTER_API_KEY <value>   (see /keys)\n'));
        continue;
      }
      cfg.keys = { ...(cfg.keys || {}), [name]: value };
      await saveConfig(cfg);
      process.env[name] = value;
      models = await loadCatalogue(cfg);
      console.log(
        C.dim(`  ${name} set for this session and saved. ${models.length} model(s) available now — /models, then /model.\n`)
      );
      continue;
    }

    if (input === '/effort' || input.startsWith('/effort ')) {
      const wanted = input.slice('/effort'.length).trim().toLowerCase();
      if (!wanted) console.log(C.dim('  Thinking effort: ' + state.reasoning + ' (adaptive chooses by task)\n'));
      else if (EFFORT_MODES.includes(wanted)) {
        state.reasoning = wanted === 'auto' ? 'adaptive' : wanted;
        console.log(C.dim('  Thinking effort set to ' + wanted + '.\n'));
      } else console.log(C.dim('  Usage: /effort auto|fast|balanced|deep\n'));
      continue;
    }

    if (input === '/model-info') {
      console.log(C.dim('  Selected: ' + model.provider + '/' + model.id + ' (' + model.source + ')\n' +
        (NO_TOOLS.has(model.provider)
          ? '  Tools: text protocol only, no native function calling. For reliable agent actions choose a tool-capable model.\n'
          : '  Tools: native function calling (where supported by the selected endpoint).\n') +
        '  Classification: model name/provider allowlist. This is not proof that a hosted model is unfiltered; providers can change routing and models may decline requests.\n'));
      continue;
    }

    if (input === '/think') {
      state.think = !state.think;
      messages[0] = {
        ...(messages[0] || { role: 'system' }),
        role: 'system',
        content: withPlanNote(messages[0]?.content ?? SYSTEM_PROMPT, state.think),
      };
      console.log(
        C.dim(
          state.think
            ? '  plan-first on — the next turn writes a 5-step TODO.md and works it in order.\n'
            : '  plan-first off.\n'
        )
      );
      continue;
    }

    if (input === '/deep' || input.startsWith('/deep ')) {
      const arg = input.slice('/deep'.length).trim();
      if (arg === 'on') state.deep = true;
      else if (arg === 'off') state.deep = false;
      else state.deep = !state.deep;
      // An explicit -n still wins; deep mode only changes the default.
      MAX_STEPS = stepBudgetFor({ maxSteps: args.maxSteps, deep: state.deep });
      messages[0] = {
        ...(messages[0] || { role: 'system' }),
        role: 'system',
        content: withDeepNote(messages[0]?.content ?? SYSTEM_PROMPT, state.deep),
      };
      console.log(
        C.dim(
          state.deep
            ? `  deep work on — ${MAX_STEPS} tool steps per window, up to ${MAX_STEPS * 3} before it stops; it carries on by itself past the first window.\n`
            : '  deep work off.\n'
        )
      );
      continue;
    }

    if (input === '/sessions') {
      const sessions = await store.list();
      if (!sessions.length) {
        console.log(C.dim('  No saved sessions yet.\n'));
        continue;
      }
      console.log(
        '\n' +
          box(
            sessions.slice(0, 20).map(
              (s, i) =>
                `${s.id === session.meta.id ? C.amber('●') : C.grey('○')} ${C.amber(String(i + 1).padEnd(3))} ${s.title} ${C.dim(
                  `(${s.messages} msgs · ${s.updated ? s.updated.slice(0, 10) : '?'})`
                )}`
            ),
            { title: 'sessions' }
          ) +
          '\n'
      );
      continue;
    }

    if (input.startsWith('/session')) {
      const arg = input.slice(8).trim();
      const sessions = await store.list();
      const hit =
        sessions.find((s) => s.id === arg) ||
        sessions[Number(arg) - 1];
      if (!hit) {
        console.log(C.dim('  No such session. /sessions to list.\n'));
        continue;
      }
      await persist();
      const loaded = await store.load(hit.id);
      session = loaded;
      messages.length = 0;
      messages.push(...(loaded.messages.length ? loaded.messages : [{ role: 'system', content: SYSTEM_PROMPT }]));
      refreshProjectContext();
      console.log('  ' + sessionHeadline(session) + '\n');
      continue;
    }

    if (input === '/new') {
      await persist();
      session = { meta: await store.create('untitled'), messages: [] };
      messages.length = 0;
      messages.push({ role: 'system', content: SYSTEM_PROMPT });
      refreshProjectContext();
      console.log('  ' + sessionHeadline(session) + '\n');
      continue;
    }

    if (input.startsWith('/rename')) {
      const title = input.slice(7).trim();
      if (!title) {
        console.log(C.dim('  Usage: /rename <title>\n'));
        continue;
      }
      session.meta = await store.rename(session.meta.id, title);
      console.log('  ' + sessionHeadline(session) + '\n');
      continue;
    }

    if (input.startsWith('/export')) {
      const dest = input.slice(7).trim() || path.join(SESSIONS_DIR, `${session.meta.id}.md`);
      try {
        const md = await store.exportMarkdown(session.meta.id);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, md, 'utf8');
        console.log(C.dim(`  Exported to ${dest}\n`));
      } catch (err) {
        console.log(C.dim(`  Export failed: ${err.message}\n`));
      }
      continue;
    }

    if (input === '/failover') {
      const summary = tracker.summary();
      if (!summary.length && sessionBadModels.size === 0) {
        console.log(C.dim('  No provider failures recorded this run. Failover is on.\n'));
      } else {
        if (sessionBadModels.size) {
          console.log(C.dim(`  Blacklisted this session (provider said unknown model): ${[...sessionBadModels].join(', ')}\n`));
        }
        if (summary.length) {
          console.log(
            '\n' +
              box(
                summary.map((s) =>
                  `${s.coolingDown ? C.red('●') : C.amber('○')} ${s.provider} ${C.dim(
                    `${s.failures} failures${s.coolingDown ? ` · cooling down (${Math.ceil(s.coolsDownInMs / 1000)}s left)` : ''}`
                  )}`
                ),
                { title: 'failover status' }
              ) +
              '\n'
          );
        }
      }
      continue;
    }

    if (input === '/context') {
      const chars = contextChars(messages);
      console.log(C.dim(`  ${messages.length} messages · ~${Math.round(chars / 1000)}k chars · compacts automatically past 60k or 80 messages`) + '\n');
      continue;
    }

    if (input === '/compact') {
      const spinC = spinner('Compacting context');
      const res = await compactInPlace(messages, { summarize, force: true }).catch(() => null);
      spinC.stop();
      console.log(C.dim(res
        ? `  [context] compacted ${res.dropped} older messages (${Math.round(res.before / 1000)}k → ${Math.round(res.after / 1000)}k chars)`
        : '  [context] nothing old enough to compact yet') + '\n');
      if (res) await persist();
      continue;
    }

    if (input === '/verbose' || input.startsWith('/verbose ')) {
      const arg = input.slice('/verbose'.length).trim();
      if (arg === 'on') state.verbose = true;
      else if (arg === 'off') state.verbose = false;
      else state.verbose = !state.verbose;
      console.log(C.dim(`  verbose ${state.verbose ? 'on: every provider the chain tries, and why it failed' : 'off: one line per turn, only when something failed'}`) + '\n');
      continue;
    }

    if (input === '/verify' || input.startsWith('/verify ')) {
      const arg = input.slice('/verify'.length).trim();
      if (!arg) {
        console.log(C.dim(verifyState.command
          ? `  verify ${verifyState.enabled ? 'on' : 'off'}: ${verifyState.command}`
          : '  verify: no test or build command found in this project. /verify <cmd> to set one.') + '\n');
        continue;
      }
      if (arg === 'off') {
        verifyState.enabled = false;
        await saveConfig({ ...cfg, verify: 'off' });
        cfg.verify = 'off';
      } else if (arg === 'on' || arg === 'auto') {
        verifyState.enabled = true;
        verifyState.command = verifyState.command || (await detectVerifyCommand(root));
        await saveConfig({ ...cfg, verify: 'auto' });
        cfg.verify = 'auto';
      } else {
        verifyState.enabled = true;
        verifyState.command = arg;
        verifyState.approved = false;
        await saveConfig({ ...cfg, verify: arg });
        cfg.verify = arg;
      }
      console.log(C.dim(`  verify ${verifyState.enabled ? 'on' : 'off'}${verifyState.command ? `: ${verifyState.command}` : ' (no command found)'}`) + '\n');
      continue;
    }

    if (input === '/map') {
      const out = await runTool('repo_map', {}, { root, approve: (d, dt) => approve(rl, d, dt) }).catch(
        (err) => `repo_map failed: ${err.message}`
      );
      console.log('\n' + String(out).split('\n').map((l) => `  ${l}`).join('\n') + '\n');
      continue;
    }

    if (input === '/undo' || input.startsWith('/undo ')) {
      const id = input.slice('/undo'.length).trim();
      const spinU = spinner('Restoring checkpoint');
      const out = await runTool(
        'checkpoint',
        { action: 'restore', ...(id ? { id } : {}) },
        { root, approve: (d, dt) => approve(rl, d, dt) }
      ).catch((err) => `Restore failed: ${err.message}`);
      spinU.stop();
      console.log('\n' + toolResult(out, { ok: /^Restored/.test(String(out)) }) + '\n');
      continue;
    }

    if (input === '/browser' || input === '/browser status') {
      const diagnostic = await browserDiagnostic({ gateway: cfg.gateway });
      console.log('\n' + box([
        diagnostic.chromium
          ? C.green('Chromium: detected (' + diagnostic.chromium + ')')
          : C.amber('Chromium: not detected'),
        diagnostic.interactive
          ? C.green('Interactive browser: supported by Node; runtime connection not yet tested')
          : C.amber('Interactive browser: Node WebSocket unavailable'),
        diagnostic.gateway
          ? C.green('Gateway: configured (read-only page fallback; not tested)')
          : C.dim('Gateway: not configured'),
        '',
        C.dim(diagnostic.chromium
          ? 'Use the agent browser tool to open, read, click, type or screenshot. CDP capability requires a live smoke test.'
          : 'Install with: pkg install chromium. Without Chromium, the gateway can read page text only.')
      ], { title: 'browser access' }) + '\n');
      continue;
    }

    if (input === '/device' || input.startsWith('/device ')) {
      const request = parseDeviceCommand(input.slice('/device'.length));
      if (request.error) {
        console.log(C.dim('  ' + request.error + '\n'));
      } else if (request.action === 'status') {
        const status = JSON.parse(await runDevice(request, { root }));
        const available = Object.entries(status.actions).filter(([,ok])=>ok).map(([name])=>name);
        const missing = Object.entries(status.actions).filter(([,ok])=>!ok).map(([name])=>name);
        console.log('\n' + box([
          (status.termuxApiCommandsInstalled ? C.green('Termux:API commands found') : C.amber('No Termux:API commands found')),
          '  Available: ' + (available.join(', ') || '(none)'),
          '  Missing: ' + (missing.join(', ') || '(none)'),
          '', C.dim(status.integration), C.dim(status.permissions), C.dim(status.deviceControl),
        ], { title: 'Android device access' }) + '\n');
      } else {
        const result = await runDevice(request, { root, approve: (title, detail) => approve(rl, title, detail) });
        console.log('\n' + box(wrap(result, width() - 6), { title: 'Android: ' + request.action }) + '\n');
      }
      continue;
    }

    if (input === '/recon' || input === '/recon status') {
      const settings = await currentRecon();
      if (!settings.enabled) {
        console.log(C.dim('  ReconAnything disabled. /recon on to enable.\n'));
      } else {
        const result = await runReconTool({ action: 'health' }, { recon: settings });
        console.log('\n' + box(wrap(result, width() - 6), { title: 'ReconAnything' }) + '\n');
        console.log(C.dim('  active scans: ' + (reconActive ? 'enabled for this session' : 'off (use /recon active on)') + '\n'));
      }
      continue;
    }

    if (input.startsWith('/recon ')) {
      const command = input.slice('/recon '.length).trim();
      if (command === 'start') {
        const started = await startLocalRecon(cfg);
        console.log('\n' + box(wrap(started.message, width() - 6), { title: started.ok ? C.green('ReconAnything ready') : C.amber('ReconAnything startup') }) + '\n');
      } else if (command === 'on' || command === 'off') {
        cfg.reconDisabled = command === 'off';
        if (cfg.reconDisabled) reconActive = false;
        await saveConfig(cfg);
        console.log(C.dim('  ReconAnything ' + (cfg.reconDisabled ? 'disabled' : 'enabled') + '.\n'));
      } else if (command === 'active on' || command === 'active off') {
        reconActive = command === 'active on' && !cfg.reconDisabled;
        console.log(C.dim('  Active scanning ' + (reconActive ? 'enabled for this session only' : 'off') + '.\n'));
      } else if (command.startsWith('url ')) {
        try {
          cfg.reconApiUrl = validateReconUrl(command.slice(4).trim());
          cfg.reconDisabled = false;
          await saveConfig(cfg);
          console.log(C.dim('  ReconAnything backend set to ' + cfg.reconApiUrl + '. Try /recon.\n'));
        } catch (err) {
          console.log(C.red('  ' + err.message + '\n'));
        }
      } else if (command.startsWith('code ')) {
        const code = command.slice(5).trim();
        if (code === 'off') delete cfg.reconAccessCode;
        else if (code) cfg.reconAccessCode = code;
        await saveConfig(cfg);
        console.log(C.dim('  ReconAnything access code ' + (code === 'off' ? 'cleared' : 'saved (not shown)') + '.\n'));
      } else {
        console.log(C.dim('  Usage: /recon, /recon start, /recon on|off, /recon url <http(s)://host:8000>, /recon code <code>|off, /recon active on|off\n'));
      }
      continue;
    }

    if (input === '/repo' || input === '/repo status') {
      console.log(C.dim('  Active repo workspace: ' + root + '\n'));
      continue;
    }

    if (input.startsWith('/repo ')) {
      const target = input.slice(6).trim();
      if (!target) {
        console.log(C.dim('  Usage: /repo owner/name, /repo https://github.com/owner/name, or /repo /path/to/local/repo\n'));
        continue;
      }
      try {
        let nextRoot;
        if (/^(?:[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+|https:\/\/github\.com\/)/.test(target)) {
          const connected = await connectGithubRepo(target, {
            approve: (desc, detail) => approve(rl, desc, detail),
          });
          if (!connected.connected) {
            console.log(C.dim('  ' + connected.reason + '\n'));
            continue;
          }
          nextRoot = connected.root;
        } else {
          nextRoot = await resolveLocalRepo(target);
        }
        if (nextRoot === root) {
          console.log(C.dim('  Already connected to this repository.\n'));
          continue;
        }
        await persist();
        await saveHistory(rl);
        rl.close();
        console.log(C.green('  Connected to repository: ' + nextRoot));
        console.log(C.dim('  Reloading model tools, project memory and verification in this workspace.\n'));
        await main(nextRoot);
        return;
      } catch (err) {
        console.log(C.red('  Repository connection failed: ' + String(err?.message || err).slice(0,300) + '\n'));
      }
      continue;
    }

    if (input === '/mcp' || input.startsWith('/mcp ')) {
      const usage = '  Usage: /mcp · /mcp add <name> <url> ["Header: value"] · /mcp test <name> · /mcp remove <name> · /mcp reload\n';
      const [sub, ...mcpArgs] = input.slice(4).trim().split(/\s+/).filter(Boolean);
      try {
        if (!sub || sub === 'list') {
          const live = mcpServers.length
            ? '  live: ' + mcpServers.map((s) => (s.ready ? `${s.name} (${s.tools.length} tools)` : `${s.name}: ${s.error}`)).join(', ')
            : '  live: none connected';
          console.log(formatServerList(cfg.mcpServers || {}).join('\n') + '\n' + C.dim(live) + '\n');
        } else if (sub === 'add') {
          const [name, url, ...headerParts] = mcpArgs;
          if (!name || !url) {
            console.log(C.dim(usage));
          } else {
            let headers = {};
            // Name and URL first, so a bad URL is reported as a bad URL
            // instead of the trailing header arg failing first.
            validateServerName(name);
            validateServerUrl(url);
            if (headerParts.length) {
              const parsed = parseHeaderArg(headerParts.join(' '));
              headers = { [parsed.name]: parsed.value };
            }
            cfg.mcpServers = addMcpServer(cfg.mcpServers || {}, name, url, headers);
            await saveConfig(cfg);
            // Connect it live now so the model can use it this session. A
            // failure leaves the saved entry in place and says so — the
            // server can be retried with /mcp test once it is reachable.
            // A same-named project .mcp.json entry is replaced in the live
            // list: the saved config wins over the project file, as at boot.
            const connected = await connectAll({ [name]: cfg.mcpServers[name] }).catch(() => []);
            const at = mcpServers.findIndex((s) => s.name === name);
            if (at >= 0) mcpServers.splice(at, 1);
            if (connected.length) mcpServers.push(...connected);
            rebuildMcpTools();
            const live = connected[0];
            console.log(
              live?.ready
                ? C.dim(`  MCP server "${name}" saved and connected (${live.tools.length} tools).\n`)
                : C.dim(`  MCP server "${name}" saved but not connected: ${live?.error || 'unknown error'}. /mcp test ${name} retries it.\n`)
            );
          }
        } else if (sub === 'test') {
          const [name] = mcpArgs;
          if (!name) {
            console.log(C.dim(usage));
          } else {
            const config = await loadMcpConfig(root, cfg.mcpServers).catch(() => ({}));
            const entry = config[name];
            if (!entry) {
              console.log(C.dim(`  No MCP server named "${name}" is configured.\n`));
            } else {
              const result = await testMcpServer(name, entry);
              console.log(
                result.ready
                  ? C.dim(`  ${name} is up: ${result.tools.length} tool(s): ${result.tools.join(', ') || 'none listed'}.\n`)
                  : C.red(`  ${name} is not reachable: ${result.error}\n`)
              );
            }
          }
        } else if (sub === 'remove') {
          const [name] = mcpArgs;
          if (!name) {
            console.log(C.dim(usage));
          } else {
            const { servers, removed } = removeMcpServer(cfg.mcpServers || {}, name);
            if (!removed) {
              console.log(C.dim(`  No MCP server named "${name}" is configured.\n`));
            } else {
              cfg.mcpServers = servers;
              await saveConfig(cfg);
              const at = mcpServers.findIndex((s) => s.name === name);
              if (at >= 0) mcpServers.splice(at, 1);
              rebuildMcpTools();
              const projectConfig = await loadMcpConfig(root, {}).catch(() => ({}));
              console.log(
                C.dim(`  MCP server "${name}" removed from the saved config.\n`) +
                  (projectConfig[name] ? C.dim(`  Note: ${name} is still in this project's .mcp.json, so it comes back on /mcp reload.\n`) : '')
              );
            }
          }
        } else if (sub === 'reload') {
          const config = await loadMcpConfig(root, cfg.mcpServers).catch(() => ({}));
          await refreshMcpLive(config);
          console.log(
            mcpLive.length
              ? C.dim(`  [mcp] ${mcpLive.map((s) => `${s.name} (${s.tools.length} tools)`).join(', ')}\n`)
              : C.red(`  [mcp] no server connected: ${mcpServers.map((s) => `${s.name}: ${s.error}`).join('; ') || 'none configured'}\n`)
          );
        } else {
          console.log(C.dim(usage));
        }
      } catch (err) {
        console.log(C.red('  ' + String(err?.message || err).slice(0, 300) + '\n'));
      }
      continue;
    }

    if (input === '/loop' || input.startsWith('/loop ')) {
      const rest = input.slice('/loop'.length).trim();
      const [duration, ...words] = rest.split(/\s+/).filter(Boolean);
      const budgetMs = parseDuration(duration);
      const objective = words.join(' ').trim();
      if (!budgetMs || !objective) {
        console.log(C.dim('  Usage: /loop <time> <objective>   e.g. /loop 45m fix the failing tests\n'));
        continue;
      }
      const run = await startAutopilot(objective, budgetMs);
      console.log('');
      continue;
    }

    if (input === '/cwd') {
      console.log(C.dim('  ' + root) + '\n');
      continue;
    }

    if (input.startsWith('/')) {
      console.log(C.dim(`  Unknown command. /help for the list.\n`));
      continue;
    }

    // A bare greeting never reaches the model: small free models invent
    // jobs for themselves when handed tools and silence ("let me grab
    // your IP"), so answer conversationally and ask what comes next.
    // Zero tool calls, by construction — no completion happens at all.
    if (isGreeting(input)) {
      const reply = greetingReply();
      messages.push({ role: 'user', content: input });
      messages.push({ role: 'assistant', content: reply });
      console.log('\n' + wrap(reply, width() - 2).join('\n'));
      await persist();
      console.log('');
      continue;
    }

    // "work on the parser for 30 minutes" is the same request as --for, in
    // the words people actually use. Narrow detector, not a general NL parser.
    const autoRequest = detectAutopilotRequest(input);
    if (autoRequest) {
      console.log(C.dim(`  [autopilot] ${formatDuration(autoRequest.budgetMs)} requested · commits when it ends`));
      await startAutopilot(input, autoRequest.budgetMs);
      console.log('');
      continue;
    }

    const reasoning = await prepareReasoning(input);
    console.log(C.dim(`  [reasoning] ${reasoning.effort} · up to ${reasoning.maxSteps} steps`));
    messages.push({ role: 'user', content: input });
    // Save the user's message BEFORE the turn runs: if Termux is killed
    // mid-turn, the old code only persisted after turn() returned, so the
    // whole last message vanished. Now a restart re-answers it instead.
    await persist();
    // A configured gateway holds the provider keys server-side (that's the
    // whole point of the deployment); without one, call providers directly
    // from the phone, which still works for the keyless providers. BOTH
    // modes walk the failover chain: the chosen model first, then the rest
    // of the catalogue when it fails OR refuses (a refusal counts as a
    // failed attempt — see lib/refusal.mjs). Gateway mode used to call the
    // chosen model once, directly, so a refusal there reached the screen
    // verbatim with the chain unwalked; now the only difference between
    // the modes is where the provider call happens.
    // If the gateway path fails, don't die: fall back to the keyless
    // direct chain for the rest of the session. Sign-in is never required
    // to keep chatting. Two gateway failures fall back: a terminal token
    // rejection, and a FailoverError (every provider failed THROUGH the
    // gateway — a dead host or paused deployment must not end the turn
    // while the direct chain still works). A fresh session retries the
    // gateway.
    const completeFn = () => completeFor(messages);
    await turn(model, messages, rl, root, completeFn, { gateway: cfg.gateway, gatewayToken: cfg.gatewayToken }, {
      verify: verifyState,
      summarize,
      verbose: state.verbose,
      trace: state.trace,
      think: state.think,
      deep: state.deep,
      spawn: runSubagent,
      mcpServers,
      reconSettings: currentRecon,
      isReconActive: () => reconActive,
      spawn: runSubagent,
      checkpoint: persist,
      reasoning,
    });
    await persist();
    console.log('');
  }

  await persist();
  await saveHistory(rl);
  rl.close();
}

// Only run the CLI when executed directly: importing this file (e.g. from
// tests/cli-turn.test.mjs) must not start the interactive loop.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(C.red(err.stack || err.message));
    process.exit(1);
  });
}

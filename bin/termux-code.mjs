#!/usr/bin/env node
/**
 * termux-code — a coding agent for Termux.
 *
 * Zero runtime dependencies on purpose: no native modules to compile on
 * aarch64, no npm install that dies halfway through on a phone. The UI is
 * raw ANSI (see lib/tui.mjs) rather than ink/blessed for the same reason.
 */

import readline from 'node:readline';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

import { runTool, run as runCommand } from '../lib/tools.mjs';
import { compactInPlace, needsCompaction, contextChars, SUMMARY_SYSTEM } from '../lib/context.mjs';
import { detectVerifyCommand, wroteFiles, pathsFromCall, exitCodeOf, failureMessage } from '../lib/verify.mjs';
import { isGatewayTool, executeGatewayTool } from '../lib/gateway-tools.mjs';
import { complete, appendToolResult, SYSTEM_PROMPT, sendToErrorInbox } from '../lib/agent.mjs';
import { isGreeting, greetingReply, shouldRefuseToolCall } from '../lib/chatty.mjs';
import { listModels, directModels } from '../lib/models.mjs';
import { FailureTracker, completeWithFailover, FailoverError, formatAttempts, gatewayFallbackReason, isUncensoredModel, renderError } from '../lib/failover.mjs';
import { SessionStore, deriveTitle } from '../lib/sessions.mjs';
import { cleanMessages, trimForGateway } from '../lib/history.mjs';
import { C, box, banner, toolHeader, toolResult, spinner, pick, wrap, width } from '../lib/tui.mjs';

const CONFIG_DIR = path.join(os.homedir(), '.termux-code');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');
const HISTORY_FILE = path.join(CONFIG_DIR, 'history');
const MAX_STEPS = 40;
const MAX_VERIFY_ATTEMPTS = 3;
const VERIFY_TIMEOUT_MS = 180_000;
const HISTORY_KEEP = 200;

/** Providers with no native function calling. They still drive tools
 *  through the text protocol (lib/text-tools.mjs), just less reliably. */
const NO_TOOLS = new Set(['gemini', 'cohere', 'horde', 'hf']);

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
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
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
    const lines = [...rl.history].reverse().slice(-HISTORY_KEEP);
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(HISTORY_FILE, lines.join('\n') + '\n', 'utf8');
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
 * The approval gate. Shows the change in a box before anything touches disk
 * or the shell, because an agent that edits your phone unsupervised is a
 * different and much worse product.
 */
async function approve(rl, desc, detail) {
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
async function completeViaGateway(gateway, model, messages, gatewayToken) {
  const res = await fetch(gateway.replace(/\/$/, '') + '/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {}),
    },
    body: JSON.stringify({ model, messages: trimForGateway(messages) }),
  });
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
  return data;
}

/**
 * Walk the failover chain for one assistant step: the chosen model first,
 * then the rest of the catalogue in failover order (keyless tool-capable,
 * then keyed, then chat-only, cooling-down providers last). Failed attempts
 * print one dim line each so a flapping provider is visible, not silent.
 */
async function runFailoverTurn(model, models, messages, tracker, completeOne, sessionBadModels) {
  const rest = models.filter(
    (m) => !(m.id === model.id && m.provider === model.provider && m.source === model.source)
  );
  const { model: winner, reply } = await completeWithFailover([model, ...rest], messages, completeOne, tracker, {
    pinFirst: model,
    sessionBadModels,
    onAttempt: (a) => {
      if (!a.ok) console.log(C.dim(`  [failover] ${a.provider} failed (${a.latencyMs}ms): ${a.error}`));
    },
  });
  if (winner.id !== model.id || winner.provider !== model.provider) {
    console.log(C.dim(`  [failover] answered by ${winner.provider}/${winner.id}`));
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
async function turn(model, messages, rl, root, completeFn, gateway = {}, agent = {}) {
  const changed = new Set();
  let verifyAttempts = 0;
  for (let step = 0; step < MAX_STEPS; step++) {
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

    const spin = spinner(step === 0 ? 'Thinking' : 'Working');
    let reply;
    try {
      reply = await completeFn();
    } catch (err) {
      spin.stop();
      if (err instanceof FailoverError) {
        console.log(
          '\n' +
            box(['Every provider in the chain failed.', '', ...formatAttempts(err.attempts).map(C.dim)], {
              title: C.red('failover exhausted'),
              colour: C.red,
            })
        );
        console.log(C.dim('  Providers cool down for 10 minutes after repeated failures. /model to switch.\n'));
      } else {
        console.log('\n' + box(wrap(err.message, width() - 6), { title: C.red('error'), colour: C.red }));
        console.log(C.dim('  /model to switch, or check the key for this provider.\n'));
      }
      return;
    }
    spin.stop();

    if (reply.text) {
      console.log('\n' + wrap(reply.text, width() - 2).join('\n'));
    }
    messages.push(reply.assistantMessage);

    // Text-protocol blocks the parser could not read: tell the model so it
    // retries with valid JSON instead of the turn silently ending.
    if (!reply.toolCalls.length && reply.textProtocolErrors?.length) {
      console.log(C.dim(`  [tools] ${reply.textProtocolErrors.length} tool call(s) had invalid JSON, asking the model to resend`));
      messages.push({
        role: 'user',
        content: `<tool_result name="error">\nYour <tool_call> block could not be parsed as JSON:\n${reply.textProtocolErrors[0]}\nResend it as {"name": "...", "args": {...}} with valid JSON.\n</tool_result>`,
      });
      continue;
    }

    if (!reply.toolCalls.length) {
      // The model thinks it's done. Check its work if it changed anything.
      const v = agent.verify;
      if (!changed.size || !v?.enabled || !v.command) return;
      if (verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
        console.log(C.red(`\n  [verify] still failing after ${MAX_VERIFY_ATTEMPTS} fix attempts. Stopping here so you can take a look.`));
        return;
      }
      if (!v.approved) {
        v.approved = await approve(rl, `Verify changes: run \`${v.command}\` (asked once per session)`, v.command);
        if (!v.approved) {
          v.enabled = false;
          console.log(C.dim('  [verify] off for this session. /verify on to re-enable.'));
          return;
        }
      }
      verifyAttempts++;
      console.log('\n' + toolHeader('verify', v.command));
      const spinV = spinner('Checking');
      const output = await runCommand(v.command, root, VERIFY_TIMEOUT_MS);
      spinV.stop();
      if (exitCodeOf(output) === 0) {
        console.log(toolResult(`passed (${v.command})`, { ok: true }));
        return;
      }
      console.log(toolResult(output.split('\n').slice(-12).join('\n'), { ok: false }));
      messages.push({ role: 'user', content: failureMessage(v.command, output, verifyAttempts, MAX_VERIFY_ATTEMPTS, changed) });
      continue;
    }

    for (const call of reply.toolCalls) {
      const arg = call.args.path || call.args.command || call.args.pattern || call.args.tool_slug || call.args.query || call.args.url || call.args.selector || '';
      console.log('\n' + toolHeader(call.name, arg));
      // Refuse an identity lookup nobody asked for before it ever reaches
      // approval or execution: a greeting must never turn into an IP
      // fetch, no matter what the model decided to call.
      const latestUser = [...messages]
        .reverse()
        .find((m) => m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('<tool_result'))?.content || '';
      if (shouldRefuseToolCall(call, latestUser)) {
        const refusal =
          'Refused: that command fetches your public IP or location from an outside service, and you did not ask for it. Answer in plain text instead, and ask what the user wants to work on.';
        console.log(toolResult(refusal, { ok: false }));
        appendToolResult(messages, model, call, refusal);
        continue;
      }
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
        } else {
          result = await runTool(call.name, call.args, {
            root,
            approve: (d, detail) => approve(rl, d, detail),
            // Only the browser tool reads these: its no-Chromium read
            // fallback goes through the gateway, like Composio does.
            gateway: gateway.gateway,
            gatewayToken: gateway.gatewayToken,
          });
        }
      } catch (err) {
        result = `Error: ${err.message}`;
        ok = false;
      }
      if (wroteFiles(call.name, result)) for (const p of pathsFromCall(call)) changed.add(p);
      console.log(toolResult(result, { ok: ok && !/Syntax check failed|JSON syntax error|WARNING:/.test(String(result)) }));
      appendToolResult(messages, model, call, result);
    }
  }
  console.log('\n' + C.red(`Stopped after ${MAX_STEPS} tool steps. Say "continue" to resume.`));
}

/* ---------- entry ---------- */

const HELP = [
  ['/model', 'pick a model for local read/edit/bash work'],
  ['/models', 'list everything reachable, grouped by source'],
  ['/ask <msg>', 'message your Error Inbox agent instead (no file access)'],
  ['/inbox-key <t>', 'save the eibx_... token /ask uses'],
  ['/gateway <url>', 'point at a different deployment'],
  ['/gateway off', 'drop the gateway, use keyless direct models'],
  ['/gateway-token <t>', 'save the gateway token minted on the deployment\u2019s landing page'],
  ['/sessions', 'list saved conversation sessions'],
  ['/session <n>', 'resume a session by number or id'],
  ['/new', 'start a new session'],
  ['/rename <t>', 'rename the current session'],
  ['/export [file]', 'export the session as Markdown'],
  ['/failover', 'show provider failover status'],
  ['/verify [on|off|<cmd>]', 'auto-check changes with the project\u2019s tests'],
  ['/compact', 'summarize older context now'],
  ['/context', 'show how much context the session uses'],
  ['/clear', 'forget this conversation'],
  ['/cwd', 'show the workspace root'],
  ['/exit', 'quit'],
];

async function main() {
  const root = process.cwd();
  const cfg = await loadConfig();

  const boot = spinner('Loading models');
  const models = await loadCatalogue(cfg);
  boot.stop();

  let model =
    models.find((m) => m.id === cfg.modelId && m.source === cfg.modelSource) ||
    // Default pick: an uncensored tool-capable model when one is in the
    // catalogue (e.g. an uncensored HF build behind a gateway key), else the
    // first free tool-capable model, as before. A saved /model choice
    // (cfg.modelId) always wins over both.
    models.find((m) => isUncensoredModel(m) && (m.auth === 'bearer' || m.auth === 'none')) ||
    models.find((m) => m.free && !NO_TOOLS.has(m.provider)) ||
    models[0];

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

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await loadHistory(rl);

  const store = new SessionStore(SESSIONS_DIR);
  const tracker = new FailureTracker();
  // Models a provider rejected as unknown (BAD_MODEL) this session.
  // completeWithFailover adds to this set on each rejection and skips
  // its entries without spending a call, so one stale model id costs
  // exactly one fast failure per session instead of one per turn.
  const sessionBadModels = new Set();
  let session = await resumeSession(store);
  // Sessions saved before the gateway-shape fix can carry poisoned entries
  // (an undefined assistant message serialized as null); drop them here so
  // a poisoned session self-heals instead of failing every later message.
  const cleanedSession = cleanMessages(session.messages);
  const messages = cleanedSession.length
    ? cleanedSession
    : [{ role: 'system', content: SYSTEM_PROMPT }];

  /** Persist the conversation without ever breaking the loop. A failed
   *  save is no longer silent: if the phone can't write, Jay should know
   *  his turns may not survive a restart. */
  const persist = async () => {
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
    const gatewayTurn = () => runFailoverTurn(model, models, msgs, tracker, (m) => completeViaGateway(cfg.gateway, m, msgs, cfg.gatewayToken), sessionBadModels);
    const directTurn = () => runFailoverTurn(model, models, msgs, tracker, (m) => complete(m, msgs), sessionBadModels);
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

  console.log(
    banner({
      cwd: path.basename(root),
      model: model.label,
      source: model.source,
      free: model.free,
    })
  );
  console.log('  ' + sessionHeadline(session));
  console.log(C.dim('  /help for commands · ctrl-c to quit\n'));

  // Once the gateway path fails (token rejected, or every provider failed
  // through it), stay on keyless direct models for the rest of the
  // session; a fresh /gateway-token re-enables the gateway.
  let gatewayDead = false;

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

    if (input === '/model') {
      const next = await chooseModel(models, model, rl);
      if (next && next !== model) {
        model = next;
        await saveConfig({ ...cfg, modelId: model.id, modelSource: model.source });
      }
      const note = NO_TOOLS.has(model.provider)
        ? C.dim(' — no native tool calling; uses the text tool protocol')
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
        console.log(wrap(reply, width() - 2).join('\n') + '\n');
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
      messages.push({ role: 'system', content: SYSTEM_PROMPT });
      await persist();
      console.log(C.dim('  Conversation cleared.\n'));
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
      console.log('  ' + sessionHeadline(session) + '\n');
      continue;
    }

    if (input === '/new') {
      await persist();
      session = { meta: await store.create('untitled'), messages: [] };
      messages.length = 0;
      messages.push({ role: 'system', content: SYSTEM_PROMPT });
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
    });
    await persist();
    console.log('');
  }

  await persist();
  await saveHistory(rl);
  rl.close();
}

main().catch((err) => {
  console.error(C.red(err.stack || err.message));
  process.exit(1);
});

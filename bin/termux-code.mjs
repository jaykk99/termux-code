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

import { runTool } from '../lib/tools.mjs';
import { complete, appendToolResult, SYSTEM_PROMPT, sendToErrorInbox } from '../lib/agent.mjs';
import { listModels, directModels } from '../lib/models.mjs';
import { C, box, banner, toolHeader, toolResult, spinner, pick, wrap, width } from '../lib/tui.mjs';

const CONFIG_DIR = path.join(os.homedir(), '.termux-code');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const MAX_STEPS = 24;

/** Providers whose function-calling shape we don't send tools to. */
const NO_TOOLS = new Set(['gemini', 'cohere', 'horde']);

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
async function loadCatalogue(cfg) {
  if (cfg.gateway) {
    try {
      const res = await fetch(cfg.gateway.replace(/\/$/, '') + '/api/models');
      if (res.ok) {
        const data = await res.json();
        if (data.models?.length) return data.models;
      }
    } catch {
      /* fall through to local discovery */
    }
  }
  try {
    const local = await listModels();
    if (local.length) return local;
  } catch {
    /* ignore */
  }
  return directModels();
}

/* ---------- prompts ---------- */

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
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
  const answer = (await ask(rl, `  ${C.amber('❯')} allow? ${C.dim('[y/N]')} `)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

/** Format one model as a picker row. */
function row(m, source) {
  const badges = [];
  if (m.free) badges.push('free');
  if (NO_TOOLS.has(m.provider)) badges.push('chat only');
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

async function turn(model, messages, rl, root) {
  for (let step = 0; step < MAX_STEPS; step++) {
    const spin = spinner(step === 0 ? 'Thinking' : 'Working');
    let reply;
    try {
      reply = await complete(model, messages);
    } catch (err) {
      spin.stop();
      console.log('\n' + box(wrap(err.message, width() - 6), { title: C.red('error'), colour: C.red }));
      console.log(C.dim('  /model to switch, or check the key for this provider.\n'));
      return;
    }
    spin.stop();

    if (reply.text) {
      console.log('\n' + wrap(reply.text, width() - 2).join('\n'));
    }
    messages.push(reply.assistantMessage);

    if (!reply.toolCalls.length) return;

    for (const call of reply.toolCalls) {
      const arg = call.args.path || call.args.command || call.args.pattern || '';
      console.log('\n' + toolHeader(call.name, arg));
      let result;
      let ok = true;
      try {
        result = await runTool(call.name, call.args, {
          root,
          approve: (d, detail) => approve(rl, d, detail),
        });
      } catch (err) {
        result = `Error: ${err.message}`;
        ok = false;
      }
      console.log(toolResult(result, { ok }));
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
  ['/inbox-key <t>', 'save the eibx_… token /ask uses'],
  ['/gateway <url>', 'point at a different deployment'],
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
    models.find((m) => m.free && !NO_TOOLS.has(m.provider)) ||
    models[0];

  if (!model) {
    console.log(
      box(
        wrap(
          'No models are reachable. Kilo, LLM7 and AI Horde need no key at all, so this usually means no network. Set a gateway with /gateway once you have one.',
          width() - 6
        ),
        { title: C.red('no models'), colour: C.red }
      )
    );
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(
    banner({
      cwd: path.basename(root),
      model: model.label,
      source: model.source,
      free: model.free,
    })
  );
  console.log(C.dim('  /help for commands · ctrl-c to quit\n'));

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  for (;;) {
    const input = (await ask(rl, `${C.amber('❯')} `)).trim();
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
        ? C.dim(' — chat only, it cannot touch your files')
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

    if (input.startsWith('/gateway')) {
      const url = input.slice(8).trim();
      if (!url) {
        console.log(C.dim('  ' + (cfg.gateway || 'No gateway set.')) + '\n');
        continue;
      }
      cfg.gateway = url;
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
      messages.length = 1;
      console.log(C.dim('  Conversation cleared.\n'));
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

    messages.push({ role: 'user', content: input });
    await turn(model, messages, rl, root);
    console.log('');
  }

  rl.close();
}

main().catch((err) => {
  console.error(C.red(err.stack || err.message));
  process.exit(1);
});

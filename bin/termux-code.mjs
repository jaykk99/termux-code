#!/usr/bin/env node
/**
 * termux-code — a coding agent for Termux.
 *
 * Zero runtime dependencies on purpose: no native modules to compile on
 * aarch64, no npm install that dies halfway through on a phone.
 */

import readline from 'node:readline';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

import { runTool } from '../lib/tools.mjs';
import { complete, appendToolResult, SYSTEM_PROMPT, sendToErrorInbox } from '../lib/agent.mjs';
import { listModels, directModels } from '../lib/models.mjs';

const CONFIG_DIR = path.join(os.homedir(), '.termux-code');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const MAX_STEPS = 24;

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  amber: (s) => `\x1b[38;5;179m${s}\x1b[0m`,
  sky: (s) => `\x1b[38;5;110m${s}\x1b[0m`,
  red: (s) => `\x1b[38;5;174m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

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
 * API keys live in Vercel's env, not in plain text on your phone.
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

async function approve(rl, desc, detail) {
  console.log('\n' + C.amber('› ' + desc));
  if (detail) console.log(C.dim(detail.split('\n').map((l) => '  ' + l).join('\n')));
  const answer = (await ask(rl, C.amber('  allow? [y/N] '))).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

const NO_TOOLS = new Set(['gemini', 'cohere', 'horde']);

async function chooseModel(rl, models, current) {
  const rows = models.slice(0, 60);
  console.log('');
  rows.forEach((m, i) => {
    const mark = current && m.id === current.id && m.source === current.source ? C.amber('●') : ' ';
    const tags = [m.free && 'free', NO_TOOLS.has(m.provider) && 'chat only, no file access'].filter(Boolean);
    console.log(`${mark} ${String(i + 1).padStart(2)}  ${m.label}${tags.length ? C.dim(' · ' + tags.join(', ')) : ''}`);
    console.log(`     ${C.dim((m.providerLabel || m.provider) + ' · ' + m.source)}`);
  });
  const answer = (await ask(rl, '\nnumber, or enter to keep current: ')).trim();
  if (!answer) return current;
  const picked = rows[Number(answer) - 1];
  if (!picked) {
    console.log(C.red('No model at that number.'));
    return current;
  }
  return picked;
}

/* ---------- the loop ---------- */

async function turn(model, messages, rl, root) {
  for (let step = 0; step < MAX_STEPS; step++) {
    let reply;
    try {
      reply = await complete(model, messages);
    } catch (err) {
      console.log(C.red(`\n${err.message}`));
      console.log(C.dim('Switch models with /model, or check your keys.'));
      return;
    }

    if (reply.text) console.log('\n' + C.sky(reply.text));
    messages.push(reply.assistantMessage);

    if (!reply.toolCalls.length) return;

    for (const call of reply.toolCalls) {
      const label = call.args.path || call.args.command || call.args.pattern || '';
      console.log(C.dim(`  ${call.name} ${label}`.trimEnd()));
      let result;
      try {
        result = await runTool(call.name, call.args, {
          root,
          approve: (d, detail) => approve(rl, d, detail),
        });
      } catch (err) {
        result = `Error: ${err.message}`;
      }
      appendToolResult(messages, model, call, result);
    }
  }
  console.log(C.red(`\nStopped after ${MAX_STEPS} steps. Say "continue" to resume.`));
}

/* ---------- entry ---------- */

async function main() {
  const root = process.cwd();
  const cfg = await loadConfig();
  const models = await loadCatalogue(cfg);

  let model =
    models.find((m) => m.id === cfg.modelId && m.source === cfg.modelSource) ||
    models.find((m) => m.free) ||
    models[0];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(C.bold('termux-code'));
  console.log(C.dim(`${path.basename(root)} · ${model.label} · ${model.source}`));
  console.log(C.dim('/model to switch, /help for commands, ctrl-c to quit\n'));

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  for (;;) {
    const input = (await ask(rl, C.amber('› '))).trim();
    if (!input) continue;

    if (input === '/exit' || input === '/quit') break;

    if (input === '/help') {
      console.log(
        [
          '/model      pick a model for local read/edit/bash work',
          '/models     list what is available',
          '/ask <msg>  send msg to your Error Inbox agent instead (no file access)',
          '/gateway    set the Vercel URL that holds your keys',
          '/clear      forget this conversation',
          '/cwd        show the workspace root',
          '/exit       quit',
        ].join('\n')
      );
      continue;
    }

    if (input.startsWith('/ask ')) {
      const message = input.slice(5).trim();
      if (!message) continue;
      try {
        const reply = await sendToErrorInbox(message, { baseUrl: cfg.errorInboxUrl, apiKey: cfg.errorInboxKey });
        console.log('\n' + C.sky(reply));
      } catch (err) {
        console.log(C.red(`\n${err.message}`));
      }
      console.log('');
      continue;
    }

    if (input === '/model') {
      model = await chooseModel(rl, models, model);
      await saveConfig({ ...cfg, modelId: model.id, modelSource: model.source });
      console.log(C.dim(`Now using ${model.label}.`));
      continue;
    }

    if (input === '/models') {
      const bySource = models.reduce((a, m) => ((a[m.source] ||= []).push(m), a), {});
      for (const [source, list] of Object.entries(bySource)) {
        console.log(`\n${source} (${list.length})`);
        list.slice(0, 20).forEach((m) => console.log('  ' + m.label));
      }
      continue;
    }

    if (input.startsWith('/gateway')) {
      const url = input.slice(8).trim();
      if (!url) {
        console.log(cfg.gateway || 'No gateway set.');
        continue;
      }
      cfg.gateway = url;
      await saveConfig(cfg);
      console.log(C.dim('Saved. Restart to reload the model list.'));
      continue;
    }

    if (input === '/clear') {
      messages.length = 1;
      console.log(C.dim('Conversation cleared.'));
      continue;
    }

    if (input === '/cwd') {
      console.log(root);
      continue;
    }

    if (input.startsWith('/inbox-key')) {
      const token = input.slice(10).trim();
      if (!token) {
        console.log(cfg.errorInboxKey ? 'A key is set.' : 'No Error Inbox key set. Mint one on its Settings page.');
        continue;
      }
      cfg.errorInboxKey = token;
      await saveConfig(cfg);
      console.log(C.dim('Saved. /ask will use it.'));
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

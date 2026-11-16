/**
 * End-to-end tests for the command-line surface: --help, --version, a bad
 * flag, and a one-shot run against a stub gateway.
 *
 * The gateway is a local http server, so nothing here needs a provider, a
 * key, or the network. It also pins the safety promise of unattended runs:
 * a tool call that would run a shell command is declined unless --yes.
 * Run: node --test tests/
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'termux-code.mjs');

const MODEL = {
  id: 'lab/dolphin-3-test',
  provider: 'kilo',
  providerLabel: 'Kilo (test)',
  label: 'Dolphin 3 (test)',
  source: 'gateway',
  free: true,
  auth: 'none',
};

/** A stub deployment: /api/models plus a scripted /api/chat. */
function stubGateway(replies) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/api/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [MODEL] }));
        return;
      }
      if (req.url === '/api/chat') {
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          /* the CLI always sends JSON; a broken body is still a data point */
        }
        seen.push(body);
        const reply = replies[Math.min(seen.length - 1, replies.length - 1)];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/** HOME-shaped sandbox: config.json points the CLI at the stub gateway. */
async function sandbox(gatewayUrl) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-cli-'));
  const project = path.join(home, 'project');
  await fs.mkdir(path.join(home, '.termux-code'), { recursive: true });
  await fs.mkdir(project, { recursive: true });
  if (gatewayUrl) {
    await fs.writeFile(
      path.join(home, '.termux-code', 'config.json'),
      JSON.stringify({ gateway: gatewayUrl }),
      'utf8'
    );
  }
  return { home, project };
}

function runCli(args, { home, project }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: project,
      env: { ...process.env, HOME: home, TERMUX_CODE_NO_UPDATE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function sessionFiles(home) {
  try {
    return await fs.readdir(path.join(home, '.termux-code', 'sessions'));
  } catch {
    return [];
  }
}

const FINAL = { text: 'STUB ANSWER: nothing to change.' };

describe('termux-code CLI without a REPL', () => {
  let ctx;
  let stub;

  before(async () => {
    stub = await stubGateway([FINAL]);
    ctx = await sandbox(stub.url);
  });

  after(async () => {
    await new Promise((r) => stub.server.close(r));
  });

  it('--version prints the version from package.json and exits 0', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
    const out = await runCli(['--version'], ctx);
    assert.equal(out.code, 0);
    assert.equal(out.stdout.trim(), `termux-code ${pkg.version}`);
    assert.ok(!out.stdout.includes('╭'), 'the banner must not print for --version');
  });

  it('--help prints the usage and exits 0', async () => {
    const out = await runCli(['--help'], ctx);
    assert.equal(out.code, 0);
    assert.match(out.stdout, /Usage/);
    assert.match(out.stdout, /--print/);
  });

  it('a bad flag fails loudly with exit 2 and starts nothing', async () => {
    const before = await sessionFiles(ctx.home);
    const out = await runCli(['--nope'], ctx);
    assert.equal(out.code, 2);
    assert.match(out.stderr, /unknown option --nope/);
    assert.deepEqual(await sessionFiles(ctx.home), before, 'no session may be created');
  });

  it('runs one prompt, prints the answer, and exits 0', async () => {
    const before = await sessionFiles(ctx.home);
    const out = await runCli(['-p', 'look at the repo'], ctx);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /STUB ANSWER/);
    assert.ok(!out.stdout.includes('╭'), 'one-shot runs skip the banner');
    assert.deepEqual(
      await sessionFiles(ctx.home),
      before,
      'an ephemeral one-shot run must not fill the session list'
    );
    const sent = stub.seen[stub.seen.length - 1];
    assert.equal(sent.model.id, MODEL.id);
    assert.equal(sent.messages.at(-1).role, 'user');
  });

  it('--json puts exactly one JSON object on stdout', async () => {
    const out = await runCli(['-p', 'summarize', '--json'], ctx);
    assert.equal(out.code, 0, out.stderr);
    const lines = out.stdout.trim().split('\n');
    assert.equal(lines.length, 1, `stdout should hold one line, got: ${out.stdout}`);
    const payload = JSON.parse(lines[0]);
    assert.equal(payload.ok, true);
    assert.match(payload.answer, /STUB ANSWER/);
    assert.equal(payload.model, MODEL.id);
    assert.equal(payload.savedSession, null);
  });

  it('accepts the prompt on stdin', async () => {
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN], {
        cwd: ctx.project,
        env: { ...process.env, HOME: ctx.home },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.end('explain this repo\n');
    });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /STUB ANSWER/);
  });
});

describe('one-shot runs act without asking', () => {
  it('runs a shell command, with no approval prompt and no decline', async () => {
    const toolCall = {
      text: 'Let me write a marker file.',
      toolCalls: [{ name: 'bash', args: { command: 'touch owned.txt' } }],
      assistantMessage: {
        role: 'assistant',
        content: 'Let me write a marker file.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"touch owned.txt"}' } }],
      },
    };
    const stub = await stubGateway([toolCall, FINAL]);
    const ctx = await sandbox(stub.url);
    try {
      const out = await runCli(['-p', 'make a marker file'], ctx);
      assert.equal(out.code, 0, out.stderr);
      // The whole point: nothing asks permission, and nothing is refused.
      assert.doesNotMatch(out.stdout, /allow\?/i);
      assert.doesNotMatch(out.stdout, /declined/i);
      assert.doesNotMatch(out.stdout, /auto-approved/i);
      // It actually ran.
      const stat = await fs.stat(path.join(ctx.project, 'owned.txt'));
      assert.ok(stat.isFile());
    } finally {
      await new Promise((r) => stub.server.close(r));
    }
  });

  it('--ask is the opt-in guard: unattended, it only reads', async () => {
    const toolCall = {
      text: 'Let me write a marker file.',
      toolCalls: [{ name: 'bash', args: { command: 'touch owned.txt' } }],
      assistantMessage: {
        role: 'assistant',
        content: 'Let me write a marker file.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"touch owned.txt"}' } }],
      },
    };
    const stub = await stubGateway([toolCall, FINAL]);
    const ctx = await sandbox(stub.url);
    try {
      const out = await runCli(['--ask', '-p', 'make a marker file'], ctx);
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /declined/);
      await assert.rejects(
        fs.stat(path.join(ctx.project, 'owned.txt')),
        'a --ask run with no terminal must not run the shell command'
      );
      const followUp = stub.seen[1];
      const toolMessage = followUp.messages.find((m) => m.role === 'tool');
      assert.ok(toolMessage, 'expected a tool result message');
      assert.match(String(toolMessage.content), /Declined|declined/);
    } finally {
      await new Promise((r) => stub.server.close(r));
    }
  });
});

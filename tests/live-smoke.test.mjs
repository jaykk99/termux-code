/**
 * Pins the live smoke harness's pass rule (scripts/live-smoke.mjs).
 *
 * The rule is the whole point of that script: a route passes only when it ran
 * a command AND left smoke.txt holding this attempt's token. It used to pass
 * on the bash call alone, which hid a run whose file was never written
 * (2026-11-22), so the statuses are asserted here without a network call, a
 * model, or a clone.
 * Run: node --test tests/live-smoke.test.mjs
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  routeStatus,
  attemptRoute,
  parseArgs,
  modeProblem,
  taskStatus,
  taskPrompt,
  attemptTask,
  gitChanges,
  commitMessage,
  branchFor,
  pushChanges,
} from '../scripts/live-smoke.mjs';
import { runTool } from '../lib/tools.mjs';

const model = { id: 'any', provider: 'horde', auth: 'horde', source: 'direct', label: 'Any available worker' };

/** The token attemptRoute put in the prompt, so a fake model can echo it. */
function tokenFrom(messages) {
  const m = String(messages[1]?.content || '').match(/SMOKE-[A-Z0-9]+/);
  return m ? m[0] : 'SMOKE-MISSING';
}

/**
 * A fake provider: `reply` sees the messages and answers like a model would,
 * then the next turn is a plain "done" so one attempt runs one tool round.
 */
function fakeAgent(reply) {
  let answered = false;
  return {
    SYSTEM_PROMPT: 'sys',
    complete: async (_model, messages) => {
      if (answered) return { text: 'done', toolCalls: [], assistantMessage: { role: 'assistant', content: 'done' } };
      answered = true;
      return reply(messages);
    },
    appendToolResult: (messages) => messages,
  };
}

const answer = (text, toolCalls = []) => ({ text, toolCalls, assistantMessage: { role: 'assistant', content: text } });

describe('routeStatus() — the pass rule', () => {
  it('passes only with a command run AND the file written', () => {
    assert.equal(routeStatus({ bashRan: true, wrote: true }), 'ok');
  });

  it('fails a route that ran nothing', () => {
    assert.equal(routeStatus({ bashRan: false, wrote: true }), 'no-tool');
    assert.equal(routeStatus({}), 'no-tool');
  });

  it('fails a route that ran a command but never wrote smoke.txt', () => {
    // The half-done run that used to be reported as ok.
    assert.equal(routeStatus({ bashRan: true, wrote: false }), 'no-file');
  });

  it('lets a refusal outrank both', () => {
    assert.equal(routeStatus({ refusal: 'I cannot help', bashRan: true, wrote: true }), 'refusal');
    assert.equal(routeStatus({ refusal: 'I cannot help', bashRan: true, wrote: false }), 'refusal');
  });
});

describe('attemptRoute() — one attempt, real tool runner', () => {
  let dir;
  const run = (reply) =>
    attemptRoute(model, {
      dir,
      env: {},
      steps: 3,
      agent: fakeAgent(reply),
      runTool,
    });

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-live-smoke-'));
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is ok when the model runs the command and writes the file', async () => {
    const r = await run((messages) =>
      answer('', [
        { id: 'a', name: 'bash', args: { command: 'node -e "process.stdout.write(String(6*7))"' } },
        { id: 'b', name: 'write_file', args: { path: 'smoke.txt', content: tokenFrom(messages) } },
      ]),
    );
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.tools, ['bash', 'write_file']);
    assert.match(r.note, /file=ok/);
  });

  it('is no-file when it runs the command but leaves no file', async () => {
    await fs.rm(path.join(dir, 'smoke.txt'), { force: true });
    const r = await run(() => answer('', [{ id: 'a', name: 'bash', args: { command: 'echo hi' } }]));
    assert.equal(r.status, 'no-file');
    assert.match(r.note, /bash=ok, file=no/);
  });

  it('is no-file when the file holds a different attempt’s token', async () => {
    await fs.writeFile(path.join(dir, 'smoke.txt'), 'SMOKE-OLD', 'utf8');
    const r = await run(() => answer('', [{ id: 'a', name: 'bash', args: { command: 'echo hi' } }]));
    assert.equal(r.status, 'no-file');
  });

  it('is no-tool when it only talks', async () => {
    await fs.rm(path.join(dir, 'smoke.txt'), { force: true });
    const r = await run(() => answer('I would run node -e "console.log(6*7)" and write the file.'));
    assert.equal(r.status, 'no-tool');
    assert.ok(r.reply.length > 0);
  });

  it('is refusal when it declines', async () => {
    const r = await run(() => answer("I can't help with running commands."));
    assert.equal(r.status, 'refusal');
    assert.match(r.note, /can't help/);
  });

  it('is error, not a crash, when the provider throws', async () => {
    const r = await run(() => {
      throw new Error('Horde: no uncensored workers online (refusing an any-worker job).');
    });
    assert.equal(r.status, 'error');
    assert.match(r.note, /no uncensored workers online/);
  });

  it('names an empty generation instead of printing a blank', async () => {
    const r = await run(() => answer(''));
    assert.equal(r.status, 'no-tool');
    assert.match(r.reply, /empty reply/);
  });
});

describe('flags — using a repo for a task', () => {
  it('reads --task and --push, and gives a task more steps than the smoke proof', () => {
    const smoke = parseArgs([]);
    assert.equal(smoke.task, null);
    assert.equal(smoke.push, false);
    assert.equal(smoke.steps, 4);

    const task = parseArgs(['--repo', 'you/thing', '--route', 'horde/any', '--task', 'add a flag', '--push']);
    assert.equal(task.repo, 'you/thing');
    assert.equal(task.route, 'horde/any');
    assert.equal(task.task, 'add a flag');
    assert.equal(task.push, true);
    assert.equal(task.steps, 12);
    assert.equal(parseArgs(['--steps', '7']).steps, 7);
  });

  it('rejects --push without a task, and a blank task', () => {
    assert.match(modeProblem(parseArgs(['--push'])), /--push needs --task/);
    assert.match(modeProblem(parseArgs(['--task', '   '])), /needs the task text/);
    assert.equal(modeProblem(parseArgs(['--task', 'do it', '--push'])), null);
    assert.equal(modeProblem(parseArgs([])), null);
  });

  it('tells the model to make the change in the checkout, not describe it', () => {
    assert.match(taskPrompt('add a --dry-run flag'), /^add a --dry-run flag/);
    assert.match(taskPrompt('x'), /real checkout/);
    assert.match(taskPrompt('x'), /not a description of it/);
  });
});

describe('taskStatus() — the task pass rule', () => {
  it('passes only when tools ran AND the checkout changed', () => {
    assert.equal(taskStatus({ tools: ['write_file'], changed: ['NOTES.md'] }), 'ok');
  });

  it('fails a route that only talked', () => {
    assert.equal(taskStatus({ tools: [], changed: ['NOTES.md'] }), 'no-tool');
    assert.equal(taskStatus({}), 'no-tool');
  });

  it('fails a route that worked but left no change behind', () => {
    assert.equal(taskStatus({ tools: ['list_dir', 'read_file'], changed: [] }), 'no-write');
  });

  it('lets a refusal outrank both', () => {
    assert.equal(taskStatus({ refusal: 'I cannot help', tools: ['write_file'], changed: ['a'] }), 'refusal');
  });
});

describe('a real task in a checkout', () => {
  let dir;
  const made = [];
  const run = (reply) =>
    attemptTask(model, { dir, env: {}, steps: 3, agent: fakeAgent(reply), runTool, task: 'add NOTES.md' });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-live-task-'));
    made.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    await fs.writeFile(path.join(dir, 'README.md'), '# thing\n', 'utf8');
    // Commit the seed so the checkout starts clean: an untracked README would
    // otherwise read as a change a model made.
    execFileSync('git', ['add', 'README.md'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed'], { cwd: dir });
  });

  after(async () => {
    await Promise.all(made.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('is ok when the model writes the change, and git sees the file', async () => {
    const r = await run(() => answer('', [{ id: 'a', name: 'write_file', args: { path: 'NOTES.md', content: 'hi\n' } }]));
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.files, ['NOTES.md']);
    assert.deepEqual(r.tools, ['write_file']);
    assert.match(r.note, /1 file\(s\) changed/);
  });

  it('is no-write when it only reads the repo', async () => {
    const r = await run(() => answer('', [{ id: 'a', name: 'read_file', args: { path: 'README.md' } }]));
    assert.equal(r.status, 'no-write');
    assert.deepEqual(r.files, []);
  });

  it('is no-tool when it only describes the change', async () => {
    const r = await run(() => answer('I would add NOTES.md with the notes inside.'));
    assert.equal(r.status, 'no-tool');
    assert.match(r.reply, /would add NOTES\.md/);
  });

  it('is refusal when it declines the task', async () => {
    const r = await run(() => answer("I can't help with that."));
    assert.equal(r.status, 'refusal');
  });

  it('reports an unchanged checkout as no changes to commit', () => {
    assert.deepEqual(gitChanges(dir), []);
  });
});

describe('committing and pushing a finished task', () => {
  let dir;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-live-push-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    await fs.writeFile(path.join(dir, 'NOTES.md'), 'hi\n', 'utf8');
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('puts the task in the commit subject and the model in the body', () => {
    const msg = commitMessage('add a --dry-run flag to bin/thing.mjs\nand document it', model);
    assert.match(msg.split('\n')[0], /^add a --dry-run flag/);
    assert.match(msg, /Task: add a --dry-run flag/);
    assert.match(msg, /Model: horde\/any/);
    assert.ok(msg.split('\n')[0].length <= 60);
  });

  it('names a review branch, never the default one', () => {
    assert.equal(branchFor(model, 'SMOKE-AB12CD'), 'live/horde-any-smokeab12cd');
    assert.doesNotMatch(branchFor(model, 'SMOKE-AB12CD'), /^(main|master)$/);
  });

  it('refuses to push without a token', () => {
    assert.throws(
      () => pushChanges({ dir, repo: 'you/thing', branch: 'live/x', env: {}, message: 'm' }),
      /--push needs GITHUB_TOKEN/,
    );
  });

  it('refuses to push straight onto main', () => {
    assert.throws(
      () => pushChanges({ dir, repo: 'you/thing', branch: 'main', env: { GITHUB_TOKEN: 't' }, message: 'm' }),
      /default branch/,
    );
  });

  it('commits the changed file and pushes the branch to the remote', async () => {
    const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-live-remote-'));
    try {
      execFileSync('git', ['init', '--bare', '-q', remote]);
      const out = pushChanges({
        dir,
        repo: 'you/thing',
        branch: 'live/horde-any-test',
        env: { GITHUB_TOKEN: 'test' },
        message: commitMessage('add NOTES.md', model),
        remote,
      });
      assert.equal(out.branch, 'live/horde-any-test');
      assert.deepEqual(out.files, ['NOTES.md']);
      assert.match(out.sha, /^[0-9a-f]{7,}$/);
      const refs = execFileSync('git', ['--git-dir', remote, 'branch', '--list', 'live/horde-any-test'], {
        encoding: 'utf8',
      });
      assert.match(refs, /live\/horde-any-test/);
      const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim();
      assert.equal(subject, 'add NOTES.md');
    } finally {
      execFileSync('rm', ['-rf', remote]);
    }
  });
});

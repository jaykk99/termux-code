/**
 * Tests for lib/cli-args.mjs — the pure argument parser and the approval
 * policy that decides whether an unattended run may write.
 * Run: node --test tests/
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, approvalModeFor, pickModel, deniedNote, withPlanNote, withDeepNote, PLAN_NOTE, DEEP_NOTE, DEFAULT_STEPS, DEEP_STEPS, stepBudgetFor, subagentStepBudget, USAGE } from '../lib/cli-args.mjs';

describe('parseArgs()', () => {
  it('leaves the interactive default alone when there are no arguments', () => {
    const opts = parseArgs([]);
    assert.deepEqual(
      { ...opts, error: undefined },
      {
        help: false,
        version: false,
        prompt: null,
        model: null,
        cwd: null,
        yes: false,
        ask: false,
        json: false,
        verbose: false,
        session: null,
        resume: false,
        think: false,
        deep: false,
        maxSteps: null,
        error: undefined,
      }
    );
    assert.equal(opts.error, null);
  });

  it('reads --resume / -r, and starts fresh without it', () => {
    // Fresh is the default: resuming the newest session on every start made a
    // new prompt continue the previous task instead of starting one.
    assert.equal(parseArgs(['--resume']).resume, true);
    assert.equal(parseArgs(['-r']).resume, true);
    assert.equal(parseArgs([]).resume, false);
    assert.match(USAGE, /--resume/);
  });

  it('reads plan-first mode', () => {
    assert.equal(parseArgs(['--think']).think, true);
    assert.equal(parseArgs(['-t']).think, true);
    assert.equal(parseArgs([]).think, false);
    assert.match(USAGE, /--think/);
  });

  it('withPlanNote() adds and removes the plan note idempotently', () => {
    const on = withPlanNote('BASE', true);
    assert.ok(on.startsWith('BASE'));
    assert.ok(on.endsWith(PLAN_NOTE));
    assert.equal(withPlanNote(on, true), on);
    assert.equal(withPlanNote(on, false), 'BASE');
  });

  it('reads deep-work mode, and never mistakes it for plan-first', () => {
    assert.equal(parseArgs(['--deep']).deep, true);
    assert.equal(parseArgs(['--deep']).think, false);
    assert.equal(parseArgs([]).deep, false);
    assert.match(USAGE, /--deep/);
  });

  it('withDeepNote() adds and removes the deep note idempotently', () => {
    const on = withDeepNote('BASE', true);
    assert.ok(on.startsWith('BASE'));
    assert.ok(on.endsWith(DEEP_NOTE));
    assert.equal(withDeepNote(on, true), on);
    assert.equal(withDeepNote(on, false), 'BASE');
    // The two notes coexist: turning plan-first on must not eat deep work.
    const both = withPlanNote(on, true);
    assert.ok(both.includes(DEEP_NOTE) && both.includes(PLAN_NOTE));
  });

  it('stepBudgetFor() gives deep mode a bigger ceiling, and -n the last word', () => {
    assert.equal(stepBudgetFor({}), DEFAULT_STEPS);
    assert.equal(stepBudgetFor({ deep: true }), DEEP_STEPS);
    assert.ok(DEEP_STEPS > DEFAULT_STEPS);
    assert.equal(stepBudgetFor({ deep: true, maxSteps: 7 }), 7);
    assert.equal(stepBudgetFor({ maxSteps: 0 }), DEFAULT_STEPS);
  });

  it('subagentStepBudget() is no longer a one-grep 8 steps', () => {
    // "read the repo, find X, then check that URL" died at 8 and reported a
    // fragment as the answer.
    assert.equal(subagentStepBudget({ parent: 40 }), 24);
    assert.equal(subagentStepBudget({ parent: 120, deep: true }), 60);
    assert.ok(subagentStepBudget({ parent: 40 }) > 8);
    // Never more than the main loop, but a tiny -n still leaves room to work.
    assert.equal(subagentStepBudget({ parent: 4 }), 12);
    assert.equal(subagentStepBudget({ parent: 20, deep: true }), 20);
  });

  it('reads the informational flags', () => {
    assert.equal(parseArgs(['--help']).help, true);
    assert.equal(parseArgs(['-h']).help, true);
    assert.equal(parseArgs(['--version']).version, true);
    assert.equal(parseArgs(['-v']).version, true);
  });

  it('takes a one-shot prompt from -p, --print and --print=', () => {
    assert.equal(parseArgs(['-p', 'add a test']).prompt, 'add a test');
    assert.equal(parseArgs(['--print', 'add a test']).prompt, 'add a test');
    assert.equal(parseArgs(['--print=add a test']).prompt, 'add a test');
  });

  it('treats bare words as the prompt, and -- as an explicit boundary', () => {
    assert.equal(parseArgs(['fix', 'the', 'build']).prompt, 'fix the build');
    assert.equal(parseArgs(['-p', 'a', '--', '-b']).prompt, 'a');
    assert.equal(parseArgs(['--', '-p', 'not-a-flag']).prompt, '-p not-a-flag');
  });

  it('keeps -p authoritative over trailing words', () => {
    const opts = parseArgs(['-p', 'first', 'second']);
    assert.equal(opts.prompt, 'first');
  });

  it('reads --model, --cwd, --session, --max-steps and --yes', () => {
    const opts = parseArgs(['-m', 'dolphin', '-C', '/tmp/proj', '--session', 'abc123', '-n', '7', '-y']);
    assert.equal(opts.model, 'dolphin');
    assert.equal(opts.cwd, '/tmp/proj');
    assert.equal(opts.session, 'abc123');
    assert.equal(opts.maxSteps, 7);
    assert.equal(opts.yes, true);
    assert.equal(opts.error, null);
  });

  it('rejects unknown options instead of silently ignoring them', () => {
    const opts = parseArgs(['--nope']);
    assert.equal(opts.prompt, null);
    assert.match(opts.error, /unknown option --nope/);
  });

  it('rejects a missing value and a non-numeric step count', () => {
    assert.match(parseArgs(['-p']).error, /needs a value/);
    assert.match(parseArgs(['--model']).error, /needs a value/);
    assert.match(parseArgs(['--print=']).error, /needs a value/);
    assert.match(parseArgs(['-n', '0']).error, /positive whole number/);
    assert.match(parseArgs(['-n', 'many']).error, /positive whole number/);
  });

  it('documents every flag it accepts in the usage text', () => {
    for (const flag of ['--print', '--yes', '--model', '--cwd', '--max-steps', '--session', '--json', '--think', '--deep', '--help', '--version']) {
      assert.ok(USAGE.includes(flag), `${flag} missing from the usage text`);
    }
  });
});

describe('approvalModeFor()', () => {
  it('never asks a confirmation the owner did not ask for', () => {
    assert.notEqual(approvalModeFor({}), 'ask');
    assert.notEqual(approvalModeFor({ prompt: 'x' }), 'ask');
    assert.notEqual(approvalModeFor({ prompt: 'x', yes: true }), 'ask');
  });

  it('says what to do when a --ask run declines', () => {
    const note = deniedNote('Run a shell command');
    assert.match(note, /declined/);
    assert.match(note, /--ask/);
  });
});

describe('pickModel()', () => {
  const models = [
    { id: 'lab/dolphin-3', provider: 'kilo', label: 'Dolphin 3' },
    { id: 'hf/Heretic-8B', provider: 'hf', label: 'Heretic 8B' },
    { id: 'any', provider: 'horde', label: 'Any available worker' },
  ];

  it('matches an exact id first', () => {
    assert.equal(pickModel(models, 'any').provider, 'horde');
  });

  it('matches a label substring, case-insensitively', () => {
    assert.equal(pickModel(models, 'heretic').id, 'hf/Heretic-8B');
    assert.equal(pickModel(models, 'DOLPHIN').id, 'lab/dolphin-3');
  });

  it('returns null for a typo so the caller can fail loudly', () => {
    assert.equal(pickModel(models, 'gpt-4'), null);
    assert.equal(pickModel(models, null), null);
  });
});

describe('approvalModeFor(): everything is approved by default', () => {
  it('never asks unless --ask is given', () => {
    assert.equal(approvalModeFor({}), 'allow');
    assert.equal(approvalModeFor({ prompt: 'fix it' }), 'allow');
    assert.equal(approvalModeFor({ yes: true }), 'allow');
    assert.equal(approvalModeFor(parseArgs([])), 'allow');
    assert.equal(approvalModeFor(parseArgs(['-p', 'ls'])), 'allow');
  });

  it('--ask restores the prompt, and reads-only when unattended', () => {
    assert.equal(approvalModeFor(parseArgs(['--ask'])), 'ask');
    assert.equal(approvalModeFor(parseArgs(['--ask', '-p', 'x'])), 'deny');
  });

  it('-y still means allow, so old scripts keep working', () => {
    assert.equal(approvalModeFor(parseArgs(['-y', '-p', 'x'])), 'allow');
  });
});

describe('--verbose', () => {
  it('is off by default and on when asked', () => {
    assert.equal(parseArgs([]).verbose, false);
    assert.equal(parseArgs(['--verbose']).verbose, true);
    assert.equal(parseArgs(['-p', 'x', '--verbose']).verbose, true);
  });

  it('leaves -v alone as --version', () => {
    // -v already meant version before --verbose existed; changing it would
    // break every script that asks a tool for its version.
    const opts = parseArgs(['-v']);
    assert.equal(opts.version, true);
    assert.equal(opts.verbose, false);
  });
});

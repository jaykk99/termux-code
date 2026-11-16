/**
 * Tests for lib/cli-args.mjs — the pure argument parser and the approval
 * policy that decides whether an unattended run may write.
 * Run: node --test tests/
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, approvalModeFor, pickModel, deniedNote, USAGE } from '../lib/cli-args.mjs';

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
        json: false,
        session: null,
        maxSteps: null,
        error: undefined,
      }
    );
    assert.equal(opts.error, null);
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
    for (const flag of ['--print', '--yes', '--model', '--cwd', '--max-steps', '--session', '--json', '--help', '--version']) {
      assert.ok(USAGE.includes(flag), `${flag} missing from the usage text`);
    }
  });
});

describe('approvalModeFor()', () => {
  it('asks in the interactive REPL', () => {
    assert.equal(approvalModeFor({}), 'ask');
  });

  it('denies writes for an unattended run unless --yes is given', () => {
    assert.equal(approvalModeFor({ prompt: 'refactor the module' }), 'deny');
    assert.equal(approvalModeFor({ prompt: 'refactor the module', yes: true }), 'allow');
  });

  it('never asks a question the run has no way to answer', () => {
    assert.notEqual(approvalModeFor({ prompt: 'x' }), 'ask');
  });

  it('says what to do when it declines', () => {
    const note = deniedNote('Run a shell command');
    assert.match(note, /declined/);
    assert.match(note, /--yes/);
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

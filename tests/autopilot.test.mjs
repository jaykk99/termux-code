import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOPILOT_DEFAULT_MS,
  AUTOPILOT_MAX_CYCLES,
  AUTOPILOT_NOTE,
  autopilotContinuation,
  commitMessageFor,
  detectAutopilotRequest,
  formatDuration,
  isTaskComplete,
  parseDuration,
  runAutopilotLoop,
  taskBlockedReason,
  withAutopilotNote,
} from '../lib/autopilot.mjs';

test('parseDuration accepts the clock forms people type', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('30m'), 1_800_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('1.5h'), 5_400_000);
  assert.equal(parseDuration('45'), 2_700_000, 'a bare number means minutes');
  assert.equal(parseDuration(' 1 h 15 m '), 4_500_000);
});

test('parseDuration rejects what is not a duration', () => {
  for (const value of ['', 'm', '30x', '1h30', 'soon', '0', '-5m', null]) {
    assert.equal(parseDuration(value), null, `${JSON.stringify(value)} should not parse`);
  }
});

test('formatDuration gives back readable labels', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(90_000), '1m 30s');
  assert.equal(formatDuration(1_800_000), '30m');
  assert.equal(formatDuration(7_500_000), '2h 5m');
});

test('detectAutopilotRequest hears a conversational time box', () => {
  assert.deepEqual(detectAutopilotRequest('work on the parser for 30 minutes'), {
    budgetMs: 1_800_000,
    durationText: '30 minutes',
  });
  assert.equal(detectAutopilotRequest('Can you keep working on this for 2 hours?').budgetMs, 7_200_000);
  assert.equal(detectAutopilotRequest('work for 1 hour 30 minutes and fix the tests').budgetMs, 5_400_000);
  assert.equal(detectAutopilotRequest('keep going for the next 90 seconds').budgetMs, 90_000);
});

test('detectAutopilotRequest leaves ordinary requests alone', () => {
  for (const prompt of [
    'fix the parser',
    'I worked on this for 3 hours yesterday',
    'work on it for a while',
    'work on it for 30',
    'write a test for 30 minutes of inactivity',
    '',
  ]) {
    assert.equal(detectAutopilotRequest(prompt), null, `${JSON.stringify(prompt)} must not start autopilot`);
  }
});

test('autopilot note is added and removed without duplicating', () => {
  const on = withAutopilotNote('BASE', true);
  assert.ok(on.startsWith('BASE'));
  assert.ok(on.endsWith(AUTOPILOT_NOTE));
  assert.equal(withAutopilotNote(on, true), on);
  assert.equal(withAutopilotNote(on, false), 'BASE');
});

test('task completion and blocker markers are recognised on their own line', () => {
  assert.equal(isTaskComplete('all done\nTASK COMPLETE'), true);
  assert.equal(isTaskComplete('**TASK COMPLETE**'), true);
  assert.equal(isTaskComplete('TASK COMPLETE.'), true);
  assert.equal(isTaskComplete('I will mark TASK COMPLETE later'), false);
  assert.equal(isTaskComplete(''), false);

  assert.equal(taskBlockedReason('BLOCKED: needs an API key'), 'needs an API key');
  assert.equal(taskBlockedReason('Nothing more.\n**BLOCKED:** repo is read-only'), 'repo is read-only');
  assert.equal(taskBlockedReason('no blocker here'), null);
});

test('the continuation keeps the remaining budget and both stop markers in view', () => {
  const note = autopilotContinuation({ cycle: 3, remainingMs: 1_800_000 });
  assert.match(note, /cycle 3/);
  assert.match(note, /30m remaining/);
  assert.match(note, /TASK COMPLETE/);
  assert.match(note, /BLOCKED:/);
});

test('runAutopilotLoop stops as soon as the goal reports complete', async () => {
  let clock = 0;
  const seen = [];
  const result = await runAutopilotLoop({
    budgetMs: 60_000,
    now: () => clock,
    runCycle: async ({ cycle }) => {
      seen.push(cycle);
      clock += 5_000;
      return { answer: cycle === 3 ? 'shipped\nTASK COMPLETE' : 'still working', progressed: true };
    },
  });
  assert.equal(result.complete, true);
  assert.equal(result.reason, 'complete');
  assert.equal(result.lastAnswer, 'shipped\nTASK COMPLETE');
  assert.deepEqual(seen, [1, 2, 3]);
});

test('runAutopilotLoop stops when the wall-clock budget is spent', async () => {
  let clock = 0;
  const result = await runAutopilotLoop({
    budgetMs: 60_000,
    now: () => clock,
    runCycle: async () => {
      clock += 25_000;
      return { answer: 'more work done', progressed: true };
    },
  });
  assert.equal(result.reason, 'budget');
  assert.equal(result.complete, false);
  assert.equal(result.cycles.length, 3, 'two full cycles fit before the deadline check stops cycle three');
  assert.ok(result.endedAt >= result.deadline);
});

test('runAutopilotLoop hands back a blocker without spending the rest of the budget', async () => {
  let clock = 0;
  const result = await runAutopilotLoop({
    budgetMs: 3_600_000,
    now: () => clock,
    runCycle: async () => {
      clock += 1_000;
      return { answer: 'BLOCKED: the deploy key is missing', progressed: true };
    },
  });
  assert.equal(result.reason, 'blocked');
  assert.equal(result.blocked, 'the deploy key is missing');
  assert.equal(result.cycles.length, 1);
});

test('runAutopilotLoop stops a stalled run instead of retrying a dead provider forever', async () => {
  let clock = 0;
  const result = await runAutopilotLoop({
    budgetMs: 3_600_000,
    now: () => clock,
    runCycle: async () => {
      clock += 1_000;
      return { answer: null, progressed: false };
    },
  });
  assert.equal(result.reason, 'stalled');
  assert.equal(result.cycles.length, 1);
});

test('runAutopilotLoop has a hard cycle ceiling even with a huge budget', async () => {
  let clock = 0;
  const result = await runAutopilotLoop({
    budgetMs: AUTOPILOT_DEFAULT_MS,
    maxCycles: 4,
    now: () => clock,
    runCycle: async () => {
      clock += 1;
      return { answer: 'still going', progressed: true };
    },
  });
  assert.equal(result.reason, 'cycle-limit');
  assert.equal(result.cycles.length, 4);
  assert.equal(AUTOPILOT_MAX_CYCLES, 40);
});

test('runAutopilotLoop reports a cycle exception as an error result', async () => {
  const result = await runAutopilotLoop({
    budgetMs: 60_000,
    runCycle: async () => {
      throw new Error('provider exploded');
    },
  });
  assert.equal(result.reason, 'error');
  assert.match(result.error.message, /provider exploded/);
});

test('commitMessageFor makes a one-line subject capped for git log', () => {
  assert.equal(commitMessageFor('fix the failing tests'), 'termux-code: fix the failing tests');
  assert.equal(commitMessageFor('  fix \n the   tests '), 'termux-code: fix the tests');
  assert.equal(commitMessageFor(''), 'termux-code: autonomous run');
  const long = commitMessageFor('x'.repeat(200), { maxLength: 40 });
  assert.equal(long.length, 40);
  assert.ok(long.endsWith('…'));
});

/**
 * Tests for lib/tui.mjs — the zero-dependency terminal UI primitives
 * (ANSI colours, boxes, the tool-call tree, spinner, list picker).
 * Run: node --test tests/tui.test.mjs
 */
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  width,
  C,
  visible,
  pad,
  clip,
  wrap,
  box,
  banner,
  toolHeader,
  toolResult,
  spinner,
  pick,
} from '../lib/tui.mjs';

describe('width', () => {
  it('is clamped to the phone-friendly range', () => {
    assert.ok(width() >= 44 && width() <= 72);
  });
});

describe('visible / pad / clip', () => {
  it('visible ignores ANSI escapes', () => {
    assert.equal(visible('plain'), 5);
    assert.equal(visible(C.bold('bold')), 4);
    assert.equal(visible(C.red('x') + C.green('yy')), 3);
    assert.equal(visible(''), 0);
  });

  it('pad pads to a visible width and never shrinks', () => {
    assert.equal(pad('ab', 5), 'ab   ');
    assert.equal(pad(C.bold('ab'), 5), `${C.bold('ab')}   `);
    assert.equal(visible(pad(C.bold('ab'), 5)), 5);
    assert.equal(pad('abcdef', 3), 'abcdef');
  });

  it('clip truncates plain text to n visible columns with an ellipsis', () => {
    assert.equal(clip('hello world', 5), 'hell…');
    assert.equal(visible(clip('hello world', 5)), 5);
    assert.equal(clip('hi', 5), 'hi');
    assert.equal(clip('hello', 5), 'hello');
  });

  it('clip keeps ANSI codes intact and closes open styling', () => {
    const styled = C.bold('hello world');
    const out = clip(styled, 5);
    assert.equal(visible(out), 5);
    assert.ok(out.startsWith('\x1b[1m'), 'keeps the bold open code');
    assert.ok(out.endsWith('\x1b[0m'), 'closes the styling it left open');
    assert.doesNotMatch(out, /world/);
  });

  it('clip does not append a reset when nothing was styled', () => {
    assert.equal(clip('hello world', 5), 'hell…');
  });
});

describe('wrap', () => {
  it('wraps on word boundaries', () => {
    assert.deepEqual(wrap('one two three four', 7), ['one two', 'three', 'four']);
  });

  it('preserves blank lines and existing newlines', () => {
    assert.deepEqual(wrap('first para\n\nsecond para', 80), ['first para', '', 'second para']);
  });

  it('keeps an over-long single word whole', () => {
    assert.deepEqual(wrap('averyverylongword', 5), ['averyverylongword']);
  });

  it('handles empty input', () => {
    assert.deepEqual(wrap('', 10), ['']);
  });
});

describe('box / banner', () => {
  it('draws a rounded box with aligned borders', () => {
    const out = box(['hello', 'a longer line here'], { title: 'T', w: 44 });
    const lines = out.split('\n');
    assert.equal(lines.length, 4); // head, 2 body, foot
    for (const line of lines) assert.equal(visible(line), 44);
    assert.match(strip(lines[0]), /^╭─ T ─+╮$/);
    assert.match(strip(lines[3]), /^╰─+╯$/);
    assert.match(lines[1], /hello/);
  });

  it('draws a title-less box', () => {
    const out = box(['x'], { w: 44 });
    assert.match(strip(out.split('\n')[0]), /^╭─+╮$/);
  });

  it('clips a line longer than the box instead of breaking alignment', () => {
    const out = box(['x'.repeat(100)], { w: 44 });
    for (const line of out.split('\n')) assert.equal(visible(line), 44);
  });

  it('banner shows model, source, cwd, and the free tag', () => {
    const out = banner({ cwd: '/home/user/projects/app', model: 'horde/llama', source: 'gateway', free: true });
    assert.match(out, /termux-code/);
    assert.match(out, /horde\/llama/);
    assert.match(out, /gateway/);
    assert.match(out, /\/home\/user\/projects\/app/);
    assert.match(strip(out), /free/);
    const paid = banner({ cwd: '/x', model: 'm', source: 's', free: false });
    assert.doesNotMatch(strip(paid), /free/);
  });
});

describe('toolHeader / toolResult', () => {
  it('toolHeader shows the name and its identifying argument', () => {
    const h = toolHeader('read_file', 'src/app.js');
    assert.match(strip(h), /⏺ read_file\(src\/app\.js\)/);
    assert.match(strip(toolHeader('bash')), /⏺ bash$/);
  });

  it('toolResult shows the first rows under a ⎿ tree', () => {
    const out = toolResult('line one\nline two\nline three');
    const lines = out.split('\n');
    assert.equal(lines.length, 3);
    assert.match(strip(lines[0]), /⎿.*line one/);
    assert.match(strip(lines[1]), /line two/);
  });

  it('toolResult collapses long output to a line count', () => {
    const text = Array.from({ length: 20 }, (_, i) => `row ${i}`).join('\n');
    const out = toolResult(text);
    assert.match(out, /… \+14 more lines/);
    assert.equal(out.split('\n').length, 7); // 6 rows + the count line
  });

  it('toolResult honours a custom max', () => {
    const out = toolResult('a\nb\nc\nd', { max: 2 });
    assert.match(out, /… \+2 more lines/);
  });

  it('toolResult tints failures red and successes dim', () => {
    assert.match(toolResult('boom', { ok: false }), /\x1b\[38;5;174m/);
    assert.match(toolResult('ok', { ok: true }), /\x1b\[2m/);
  });

  it('toolResult skips blank lines and expands tabs', () => {
    const out = toolResult('a\n\n\tb');
    assert.match(out, /a/);
    assert.match(out, /  b/);
    assert.equal(out.split('\n').length, 2);
  });
});

describe('spinner', () => {
  it('is a no-op when stderr is not a TTY', () => {
    // In the test runner stderr is piped, so the spinner must not write.
    const s = spinner('Thinking');
    assert.equal(typeof s.stop, 'function');
    assert.doesNotThrow(() => s.stop());
  });
});

describe('pick (non-TTY fallback)', () => {
  const items = [
    { label: 'Model A', meta: 'fast, free' },
    { label: 'Model B', meta: 'slow, smart', badge: 'pinned' },
    { label: 'Model C' },
  ];

  it('returns the picked index for a valid number', async () => {
    const n = await pick(items, { title: 'Pick a model', ask: async () => '2' });
    assert.equal(n, 1);
  });

  it('returns null on an empty answer (keep current)', async () => {
    assert.equal(await pick(items, { ask: async () => '' }), null);
    assert.equal(await pick(items, { ask: async () => '   ' }), null);
  });

  it('returns null for out-of-range or non-numeric answers', async () => {
    assert.equal(await pick(items, { ask: async () => '99' }), null);
    assert.equal(await pick(items, { ask: async () => '0' }), null);
    assert.equal(await pick(items, { ask: async () => 'abc' }), null);
  });

  it('returns null with no ask function when stdin is not a TTY', async () => {
    assert.equal(await pick(items, {}), null);
  });

  it('honours the current marker without crashing', async () => {
    const n = await pick(items, { current: 1, ask: async () => '3' });
    assert.equal(n, 2);
  });
});

describe('colours', () => {
  it('every colour helper wraps in escapes and resets', () => {
    for (const [name, fn] of Object.entries(C)) {
      const out = fn('x');
      assert.ok(out.startsWith('\x1b['), name);
      assert.ok(out.endsWith('\x1b[0m'), name);
      assert.equal(visible(out), 1, name);
    }
  });
});

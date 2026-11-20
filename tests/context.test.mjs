/**
 * Tests for lib/context.mjs — automatic compaction for long conversations.
 * Run: node --test tests/context.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPACT_AT_CHARS,
  COMPACT_AT_MESSAGES,
  KEEP_RECENT_CHARS,
  SUMMARY_MARK,
  SUMMARY_SYSTEM,
  messageChars,
  contextChars,
  needsCompaction,
  digest,
  chooseCut,
  compactInPlace,
} from '../lib/context.mjs';

const u = (content) => ({ role: 'user', content });
const a = (content, tool_calls) => ({ role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) });
const tool = (content, name = 'read_file') => ({ role: 'tool', name, content });
const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });

describe('messageChars / contextChars', () => {
  it('counts string content plus tool-call JSON', () => {
    assert.equal(messageChars(u('hello')), 5);
    assert.equal(messageChars(a('hi', [call('read_file', { path: 'x.js' })])), 2 + JSON.stringify([call('read_file', { path: 'x.js' })]).length);
    assert.equal(messageChars(null), 0);
    assert.equal(messageChars(a(['block'])), JSON.stringify(['block']).length);
  });

  it('sums a whole history', () => {
    assert.equal(contextChars([u('ab'), u('cde')]), 5);
    assert.equal(contextChars([]), 0);
    assert.equal(contextChars(null), 0);
  });
});

describe('needsCompaction', () => {
  it('fires past the char budget', () => {
    assert.equal(needsCompaction([u('x'.repeat(COMPACT_AT_CHARS + 1))]), true);
    assert.equal(needsCompaction([u('short')]), false);
  });

  it('fires past the message budget', () => {
    const many = Array.from({ length: COMPACT_AT_MESSAGES + 1 }, () => u('hi'));
    assert.equal(needsCompaction(many), true);
    assert.equal(needsCompaction(Array.from({ length: COMPACT_AT_MESSAGES }, () => u('hi'))), false);
  });

  it('accepts custom budgets', () => {
    assert.equal(needsCompaction([u('12345')], { maxChars: 4 }), true);
    assert.equal(needsCompaction([u('1'), u('2')], { maxMessages: 1 }), true);
  });
});

describe('digest', () => {
  it('lists user requests oldest first', () => {
    const d = digest([u('first task'), a('ok'), u('second task')]);
    assert.match(d, /User requests, oldest first:/);
    assert.ok(d.indexOf('first task') < d.indexOf('second task'));
  });

  it('excludes a previous summary message from requests', () => {
    const d = digest([u(`${SUMMARY_MARK}\nold stuff`), u('real request')]);
    assert.doesNotMatch(d, /old stuff/);
    assert.match(d, /real request/);
  });

  it('tracks files read and changed, with verbs', () => {
    const d = digest([
      a('', [call('read_file', { path: 'a.js' })]),
      a('', [call('write_file', { path: 'b.js' })]),
      a('', [call('edit_file', { path: 'c.js' })]),
      a('', [call('multi_edit', { path: 'd.js' })]),
    ]);
    assert.match(d, /Files changed: b\.js \(wrote\), c\.js \(edited\), d\.js \(edited\)/);
    assert.match(d, /Files read: a\.js/);
  });

  it('pulls patched files out of apply_patch diffs', () => {
    const patch = '--- a/old.js\n+++ b/new.js\n@@ -1 +1 @@\n-old\n+new\n';
    const d = digest([a('', [call('apply_patch', { patch })])]);
    assert.match(d, /Files changed: new\.js \(patched\)/);
    assert.doesNotMatch(d, /\/dev\/null/);
  });

  it('records commands with exit codes from tool results', () => {
    const d = digest([
      a('', [call('bash', { command: 'npm test' })]),
      tool('output\nexit 0'),
      a('', [call('bash', { command: 'make build' })]),
      tool('boom\nexit 2'),
    ]);
    assert.match(d, /Commands run \(exit code\):/);
    assert.match(d, /npm test → 0/);
    assert.match(d, /make build → 2/);
  });

  it('leaves unknown exit codes as ?', () => {
    const d = digest([a('', [call('bash', { command: 'sleep 1' })])]);
    assert.match(d, /sleep 1 → \?/);
  });

  it('elides the middle when there are many requests', () => {
    const msgs = Array.from({ length: 15 }, (_, i) => u(`request ${i}`));
    const d = digest(msgs);
    assert.match(d, /\(3 more\)/);
    assert.match(d, /request 0/);
    assert.match(d, /request 14/);
    // The last 10 requests survive; requests 2-4 are the elided middle.
    assert.match(d, /request 7/);
    assert.doesNotMatch(d, /request 3/);
  });

  it('returns an empty string for an empty history', () => {
    assert.equal(digest([]), '');
  });

  it('clips very long request lines', () => {
    const d = digest([u('x'.repeat(500))]);
    assert.ok(d.length < 500);
    assert.match(d, /…/);
  });
});

describe('chooseCut', () => {
  const msgs = [
    u('first user turn, a fairly long request about the project'),
    a('first assistant answer, also fairly long with some detail'),
    u('second user turn with more work to do here'),
    a('second assistant answer'),
    u('latest question'),
  ];

  it('returns -1 when the whole history fits in keepChars', () => {
    assert.equal(chooseCut(msgs, 0, 10_000), -1);
  });

  it('cuts on a plain user message inside the keep window', () => {
    const cut = chooseCut(msgs, 0, 40);
    assert.ok(cut > 0);
    assert.equal(msgs[cut].role, 'user');
    assert.equal(msgs[cut].content, 'latest question');
  });

  it('never returns the start index', () => {
    assert.equal(chooseCut([u('only one')], 0, 1), -1);
  });

  it('falls back to an assistant message when no user message is in range', () => {
    const onlyAssistant = [a('one'), a('two'), a('three')];
    const cut = chooseCut(onlyAssistant, 0, 5);
    assert.ok(cut > 0);
    assert.equal(onlyAssistant[cut].role, 'assistant');
  });

  it('skips an orphaned assistant start', () => {
    // An assistant message whose tool_calls point at a result that was
    // already cut must not become the new head of the history.
    const orphaned = { role: 'assistant', content: '', tool_calls: [call('read_file', { path: 'x' })] };
    const cut = chooseCut([orphaned, a('plain answer')], 0, 5);
    assert.equal(cut, 1);
  });
});

describe('compactInPlace', () => {
  function bigHistory() {
    return [
      { role: 'system', content: 'You are a coding agent.' },
      u('build me a widget that shows the weather'),
      a('Sure, here is the plan.'),
      a('', [call('write_file', { path: 'widget.js' })]),
      tool('Wrote widget.js'),
      u('now add a settings page for it'),
      a('Done, settings are in settings.js.'),
      u('and make the widget refresh every minute'),
      a('Refreshing every minute now.'),
    ];
  }

  it('returns null when nothing exceeds the budget', async () => {
    const msgs = [u('hi')];
    assert.equal(await compactInPlace(msgs), null);
    assert.equal(msgs.length, 1);
  });

  it('compacts with force, keeps the system prompt, shrinks the history', async () => {
    // A long history: several 500-char assistant replies that the digest
    // (bounded, requests clipped at 300 chars) is far smaller than.
    const msgs = [
      { role: 'system', content: 'You are a coding agent.' },
      ...Array.from({ length: 6 }, (_, i) => [
        u(`request ${i}: please refactor the widget module`),
        a(`answer ${i}: ` + 'x'.repeat(500)),
      ]).flat(),
      u('final question about the widget'),
      a('final answer'),
    ];
    const before = contextChars(msgs);
    const res = await compactInPlace(msgs, { force: true, keepChars: 60 });
    assert.ok(res);
    assert.equal(res.before, before);
    assert.ok(res.after < before, `after ${res.after} should be < before ${before}`);
    assert.ok(res.dropped > 0);
    assert.equal(res.usedModel, false);
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[0].content, 'You are a coding agent.');
    const joined = msgs.map((m) => String(m.content)).join('\n');
    assert.match(joined, new RegExp(SUMMARY_MARK.replace(/[[\]]/g, (c) => `\\${c}`)));
    assert.match(joined, /request 0/);
  });

  it('folds the summary into the first kept user message', async () => {
    const msgs = bigHistory();
    // keepChars 75 keeps the last user turn plus the final answer verbatim,
    // so the summary folds into that user message with a [Current] marker.
    await compactInPlace(msgs, { force: true, keepChars: 75 });
    const firstUser = msgs.find((m) => m.role === 'user');
    assert.ok(firstUser.content.startsWith(SUMMARY_MARK));
    assert.match(firstUser.content, /\[Current\]/);
    assert.match(firstUser.content, /and make the widget refresh every minute/);
  });

  it('uses the model summary when the summarizer answers', async () => {
    const msgs = bigHistory();
    const res = await compactInPlace(msgs, {
      force: true,
      keepChars: 60,
      summarize: async (prompt) => {
        assert.match(prompt, /Transcript to compress/);
        return 'MODEL SUMMARY: widget built, settings added.';
      },
    });
    assert.equal(res.usedModel, true);
    assert.match(msgs.map((m) => String(m.content)).join('\n'), /MODEL SUMMARY/);
  });

  it('falls back to the digest when the summarizer times out', async () => {
    const msgs = bigHistory();
    const res = await compactInPlace(msgs, {
      force: true,
      keepChars: 60,
      timeoutMs: 10,
      summarize: () => new Promise(() => {}),
    });
    assert.equal(res.usedModel, false);
    assert.match(msgs.map((m) => String(m.content)).join('\n'), /User requests/);
  });

  it('falls back to the digest when the summarizer throws', async () => {
    const msgs = bigHistory();
    const res = await compactInPlace(msgs, {
      force: true,
      keepChars: 60,
      summarize: async () => {
        throw new Error('provider down');
      },
    });
    assert.equal(res.usedModel, false);
    assert.ok(res.dropped > 0);
  });

  it('folds a previous summary in instead of stacking summaries', async () => {
    const msgs = bigHistory();
    await compactInPlace(msgs, { force: true, keepChars: 60, summarize: async () => 'FIRST SUMMARY' });
    // Grow it again and compact a second time.
    msgs.push(u('one more change please'), a('done that too'));
    await compactInPlace(msgs, { force: true, keepChars: 60, summarize: async () => 'SECOND SUMMARY' });
    const joined = msgs.map((m) => String(m.content)).join('\n');
    assert.equal(joined.split(SUMMARY_MARK).length - 1, 1, 'exactly one summary marker');
    assert.match(joined, /SECOND SUMMARY/);
  });

  it('returns null when no clean cut exists', async () => {
    const msgs = [u('x')];
    assert.equal(await compactInPlace(msgs, { force: true, keepChars: 1 }), null);
  });

  it('SUMMARY_SYSTEM asks for a terse plain-text summary', () => {
    assert.match(SUMMARY_SYSTEM, /250 words/);
    assert.match(SUMMARY_SYSTEM, /No preamble/);
    assert.equal(KEEP_RECENT_CHARS, 18_000);
  });
});

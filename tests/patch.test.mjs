/**
 * Tests for lib/patch.mjs — unified-diff parsing and application, built
 * for what models actually write (wrong line numbers, missing prefixes,
 * code fences, bare @@ headers).
 * Run: node --test tests/patch.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePatch, applyPatchText } from '../lib/patch.mjs';

describe('parsePatch', () => {
  it('parses a plain modify diff', () => {
    const files = parsePatch([
      '--- a/src/app.js',
      '+++ b/src/app.js',
      '@@ -1,3 +1,3 @@',
      ' line one',
      '-old line',
      '+new line',
      ' line three',
    ].join('\n'));
    assert.equal(files.length, 1);
    assert.equal(files[0].oldPath, 'src/app.js');
    assert.equal(files[0].newPath, 'src/app.js');
    assert.equal(files[0].hunks.length, 1);
    assert.equal(files[0].hunks[0].oldStart, 1);
    assert.deepEqual(files[0].hunks[0].lines, [
      { op: ' ', text: 'line one' },
      { op: '-', text: 'old line' },
      { op: '+', text: 'new line' },
      { op: ' ', text: 'line three' },
    ]);
  });

  it('parses a create (old /dev/null) and a delete (new /dev/null)', () => {
    const created = parsePatch('--- /dev/null\n+++ b/new.js\n@@ -0,0 +1 @@\n+hello\n');
    assert.equal(created[0].oldPath, null);
    assert.equal(created[0].newPath, 'new.js');

    const deleted = parsePatch('--- a/gone.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n');
    assert.equal(deleted[0].oldPath, 'gone.js');
    assert.equal(deleted[0].newPath, null);
  });

  it('accepts paths without a/ and b/ prefixes', () => {
    const files = parsePatch('--- src/app.js\n+++ src/app.js\n@@ -1 +1 @@\n-a\n+b\n');
    assert.equal(files[0].oldPath, 'src/app.js');
    assert.equal(files[0].newPath, 'src/app.js');
  });

  it('strips a code fence around the diff', () => {
    const files = parsePatch('```diff\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\n```\n');
    assert.equal(files.length, 1);
    assert.equal(files[0].hunks[0].lines.length, 2);
  });

  it('skips diff --git, index, and mode lines, and handles multiple files', () => {
    const files = parsePatch([
      'diff --git a/one.js b/one.js',
      'index abc123..def456 100644',
      '--- a/one.js',
      '+++ b/one.js',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/two.js b/two.js',
      '--- a/two.js',
      '+++ b/two.js',
      '@@ -1 +1 @@',
      '-c',
      '+d',
    ].join('\n'));
    assert.equal(files.length, 2);
    assert.deepEqual(files.map((f) => f.newPath), ['one.js', 'two.js']);
  });

  it('accepts a bare @@ header with no numbers', () => {
    const files = parsePatch('--- a/x.js\n+++ b/x.js\n@@\n-a\n+b\n');
    assert.equal(files[0].hunks[0].oldStart, null);
  });

  it('accepts a hunk header with a function name after @@', () => {
    const files = parsePatch('--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,2 @@ function foo()\n-a\n+b\n');
    assert.equal(files[0].hunks[0].oldStart, 1);
  });

  it('treats a blank line in a hunk as blank context', () => {
    const files = parsePatch('--- a/x.js\n+++ b/x.js\n@@ -1,3 +1,3 @@\n a\n\n b\n');
    assert.deepEqual(files[0].hunks[0].lines, [
      { op: ' ', text: 'a' },
      { op: ' ', text: '' },
      { op: ' ', text: 'b' },
    ]);
  });

  it('handles CRLF input', () => {
    const files = parsePatch('--- a/x.js\r\n+++ b/x.js\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n');
    assert.equal(files[0].hunks[0].lines[1].text, 'b');
  });

  it('throws when both sides are /dev/null', () => {
    assert.throws(() => parsePatch('--- /dev/null\n+++ /dev/null\n@@ -0,0 +1 @@\n+x\n'), /both sides/);
  });

  it('throws when a hunk has no file header before it', () => {
    assert.throws(() => parsePatch('@@ -1 +1 @@\n-a\n+b\n'), /no --- \/ \+\+\+ file header/);
  });

  it('throws on a header with no hunks', () => {
    assert.throws(() => parsePatch('--- a/x.js\n+++ b/x.js\n'), /has a header but no hunks/);
  });

  it('throws on a garbage line inside a hunk', () => {
    assert.throws(
      () => parsePatch('--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\nthis is not a diff line\n'),
      /unexpected line in hunk/
    );
  });

  it('drops a trailing blank context line from a stripped final newline', () => {
    const files = parsePatch('--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,2 @@\n a\n \n');
    assert.deepEqual(files[0].hunks[0].lines, [{ op: ' ', text: 'a' }]);
  });
});

describe('applyPatchText', () => {
  const FILE = 'line one\nold line\nline three\n';

  it('replaces lines at the stated position', () => {
    const { text, spans, error } = applyPatchText(FILE, [{
      oldStart: 1,
      lines: [
        { op: ' ', text: 'line one' },
        { op: '-', text: 'old line' },
        { op: '+', text: 'new line' },
        { op: ' ', text: 'line three' },
      ],
    }]);
    assert.equal(error, undefined);
    assert.equal(text, 'line one\nnew line\nline three\n');
    assert.equal(spans.length, 1);
  });

  it('finds the hunk by context when the line numbers are wrong', () => {
    const { text } = applyPatchText(FILE, [{
      oldStart: 99, // the model miscounted; context still locates it
      lines: [
        { op: ' ', text: 'line one' },
        { op: '-', text: 'old line' },
        { op: '+', text: 'new line' },
      ],
    }]);
    assert.equal(text, 'line one\nnew line\nline three\n');
  });

  it('locates the hunk despite trailing-whitespace differences', () => {
    // The loose second pass matches on trimEnd, so the hunk is found even
    // though the file's context line carries trailing spaces the model
    // did not reproduce. (The replaced lines take the hunk's text, so the
    // trailing spaces on that line go with the old line.)
    const { text } = applyPatchText('line one  \nold line\nline three\n', [{
      oldStart: 1,
      lines: [
        { op: ' ', text: 'line one' },
        { op: '-', text: 'old line' },
        { op: '+', text: 'new line' },
      ],
    }]);
    assert.equal(text, 'line one\nnew line\nline three\n');
  });

  it('inserts lines for a pure-insertion hunk', () => {
    const { text } = applyPatchText(FILE, [{
      oldStart: 2,
      lines: [{ op: '+', text: 'inserted line' }],
    }]);
    assert.equal(text, 'line one\nold line\ninserted line\nline three\n');
  });

  it('appends a pure insertion with no line number at the end', () => {
    const { text } = applyPatchText(FILE, [{ oldStart: null, lines: [{ op: '+', text: 'tail line' }] }]);
    assert.equal(text, 'line one\nold line\nline three\ntail line\n');
  });

  it('deletes lines', () => {
    const { text } = applyPatchText(FILE, [{
      oldStart: 1,
      lines: [
        { op: ' ', text: 'line one' },
        { op: '-', text: 'old line' },
        { op: ' ', text: 'line three' },
      ],
    }]);
    assert.equal(text, 'line one\nline three\n');
  });

  it('applies several hunks in one file, in order', () => {
    const { text } = applyPatchText('a\nb\nc\nd\ne\nf\n', [
      { oldStart: 1, lines: [{ op: '-', text: 'a' }, { op: '+', text: 'A' }] },
      { oldStart: 5, lines: [{ op: '-', text: 'e' }, { op: '+', text: 'E' }] },
    ]);
    assert.equal(text, 'A\nb\nc\nd\nE\nf\n');
  });

  it('returns an error naming the hunk that does not fit', () => {
    const { error, text } = applyPatchText(FILE, [{
      oldStart: 1,
      lines: [{ op: '-', text: 'a line that is not there' }, { op: '+', text: 'x' }],
    }]);
    assert.match(error, /hunk 1 does not match the file/);
    assert.match(error, /a line that is not there/);
    assert.equal(text, undefined);
  });

  it('creates a file from empty content', () => {
    const { text } = applyPatchText('', [{ oldStart: 0, lines: [{ op: '+', text: 'first' }, { op: '+', text: 'second' }] }]);
    assert.equal(text, 'first\nsecond\n');
  });

  it('preserves a missing trailing newline', () => {
    const { text } = applyPatchText('a\nb', [{ oldStart: 1, lines: [{ op: '-', text: 'a' }, { op: '+', text: 'A' }] }]);
    assert.equal(text, 'A\nb');
  });

  it('reports char spans covering the added lines', () => {
    const { spans } = applyPatchText(FILE, [{
      oldStart: 1,
      lines: [
        { op: ' ', text: 'line one' },
        { op: '-', text: 'old line' },
        { op: '+', text: 'new line' },
        { op: ' ', text: 'line three' },
      ],
    }]);
    assert.equal(spans.length, 1);
    const [start, end] = spans[0];
    const out = 'line one\nnew line\nline three\n';
    // Spans are [first char, last char] of the added lines, where the last
    // char is the newline ending the final added line.
    assert.equal(out.slice(start, end), 'new line');
  });

  it('round-trips a full parse + apply', () => {
    const diff = [
      '--- a/notes.txt',
      '+++ b/notes.txt',
      '@@ -2,2 +2,3 @@',
      ' keep',
      '-drop this',
      '+added one',
      '+added two',
    ].join('\n');
    const files = parsePatch(diff);
    const { text, error } = applyPatchText('title\nkeep\ndrop this\nend\n', files[0].hunks);
    assert.equal(error, undefined);
    assert.equal(text, 'title\nkeep\nadded one\nadded two\nend\n');
  });
});

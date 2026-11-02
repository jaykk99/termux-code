/**
 * Unified-diff parsing and application for the apply_patch tool.
 *
 * Built for what models actually write, not just what `git diff` emits:
 *   - a/ and b/ prefixes are optional; `diff --git`, `index`, mode lines
 *     and "\ No newline at end of file" are skipped.
 *   - hunk line numbers are treated as a hint. Models miscount constantly,
 *     so each hunk is located by its context: first at the stated line,
 *     then searching outward, then once more ignoring trailing whitespace.
 *   - a bare `@@` header with no numbers is accepted (search everywhere).
 *   - hunk line counts in the header are ignored; the hunk body decides.
 *
 * Nothing here touches the filesystem; lib/tools.mjs reads, applies all
 * files in memory, asks for approval, and only then writes.
 */

function stripPrefix(p) {
  let s = String(p).trim().replace(/\t.*$/, ''); // drop "\t<timestamp>"
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

/**
 * Parse a unified diff into files:
 *   [{ oldPath, newPath, hunks: [{ oldStart, lines: [{ op, text }] }] }]
 * oldPath null = create, newPath null = delete.
 */
export function parsePatch(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  // Models often wrap the diff in a code fence.
  while (lines.length && /^```/.test(lines[0].trim())) lines.shift();
  while (lines.length && (/^```/.test(lines[lines.length - 1].trim()) || lines[lines.length - 1] === '')) lines.pop();

  const files = [];
  let file = null;
  let hunk = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      file = { oldPath: stripPrefix(line.slice(4)), newPath: stripPrefix(lines[i + 1].slice(4)), hunks: [] };
      if (file.oldPath === null && file.newPath === null) throw new Error('both sides of a file header are /dev/null');
      files.push(file);
      hunk = null;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!file) throw new Error(`hunk at line ${i + 1} has no --- / +++ file header before it`);
      const m = line.match(/^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/);
      hunk = { oldStart: m ? Number(m[1]) : null, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue; // diff --git, index, mode lines, prose between files
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    const op = line[0];
    if (op === ' ' || op === '-' || op === '+') hunk.lines.push({ op, text: line.slice(1) });
    else if (line === '') hunk.lines.push({ op: ' ', text: '' }); // editors strip the space on blank context lines
    else if (line.startsWith('diff ') || line.startsWith('index ')) hunk = null;
    else throw new Error(`unexpected line in hunk ${file.hunks.length} of ${file.newPath ?? file.oldPath}: "${line.slice(0, 60)}"`);
  }
  for (const f of files) {
    // Trailing blank context lines from a stripped final newline add nothing.
    for (const h of f.hunks) while (h.lines.length && h.lines[h.lines.length - 1].op === ' ' && h.lines[h.lines.length - 1].text === '') h.lines.pop();
    f.hunks = f.hunks.filter((h) => h.lines.length);
    if (!f.hunks.length && f.oldPath !== null && f.newPath !== null && f.oldPath === f.newPath) {
      throw new Error(`${f.newPath} has a header but no hunks`);
    }
  }
  return files;
}

function matchAt(lines, block, at, loose) {
  if (at < 0 || at + block.length > lines.length) return false;
  for (let k = 0; k < block.length; k++) {
    const a = lines[at + k];
    const b = block[k];
    if (loose ? a.trimEnd() !== b.trimEnd() : a !== b) return false;
  }
  return true;
}

/** Find block in lines at/after `min`, nearest to `hint` first. */
function locate(lines, block, hint, min) {
  for (const loose of [false, true]) {
    const start = Math.max(min, Math.min(hint, lines.length));
    for (let d = 0; d <= lines.length; d++) {
      const fwd = start + d;
      const back = start - d;
      if (fwd <= lines.length && matchAt(lines, block, fwd, loose)) return fwd;
      if (d && back >= min && matchAt(lines, block, back, loose)) return back;
      if (fwd > lines.length && back < min) break;
    }
  }
  return -1;
}

/**
 * Apply parsed hunks to a file's text. Returns { text, spans } on
 * success (spans = [start, end] char ranges of added lines in the new
 * text) or { error } naming the hunk that did not fit.
 */
export function applyPatchText(before, hunks) {
  const lines = String(before).split('\n');
  const hadTrailingNewline = before === '' || before.endsWith('\n');
  if (hadTrailingNewline && lines.length && lines[lines.length - 1] === '') lines.pop();

  const addedRanges = []; // [firstLine, lastLine] 0-based in the new file
  let min = 0;
  let shift = 0;
  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h];
    const oldBlock = hunk.lines.filter((l) => l.op !== '+').map((l) => l.text);
    const newBlock = hunk.lines.filter((l) => l.op !== '-').map((l) => l.text);
    const hint = hunk.oldStart ? hunk.oldStart - 1 + shift : min;
    let at;
    if (!oldBlock.length) {
      // Pure insertion: trust the line number (or the end for a new file).
      at = hunk.oldStart ? Math.min(Math.max(hunk.oldStart + shift, min), lines.length) : lines.length;
      if (hunk.oldStart === 0) at = Math.max(0, min);
    } else {
      at = locate(lines, oldBlock, hint, min);
      if (at === -1) {
        const want = oldBlock.find((t) => t.trim()) ?? oldBlock[0];
        return {
          error: `hunk ${h + 1} does not match the file (looking for "${String(want).trim().slice(0, 80)}"). Read the file and regenerate the patch with exact context lines.`,
        };
      }
    }
    lines.splice(at, oldBlock.length, ...newBlock);
    // Record + lines, by position within the new block.
    let pos = at;
    let runStart = -1;
    for (const l of hunk.lines) {
      if (l.op === '-') continue;
      if (l.op === '+') {
        if (runStart === -1) runStart = pos;
      } else if (runStart !== -1) {
        addedRanges.push([runStart, pos - 1]);
        runStart = -1;
      }
      pos++;
    }
    if (runStart !== -1) addedRanges.push([runStart, pos - 1]);
    shift += newBlock.length - oldBlock.length;
    min = at + newBlock.length;
  }

  const text = lines.join('\n') + (hadTrailingNewline && lines.length ? '\n' : '');
  // Line ranges -> char spans for the post-write excerpt.
  const offsets = [0];
  for (let i = 0; i < lines.length; i++) offsets.push(offsets[i] + lines[i].length + 1);
  const spans = addedRanges.map(([a, b]) => [offsets[a], Math.max(offsets[a], offsets[b + 1] - 1)]);
  return { text, spans };
}

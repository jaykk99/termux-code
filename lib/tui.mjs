/**
 * Terminal UI primitives, in the style Claude Code popularised: a rounded
 * banner box, a bordered input line, tool calls rendered as a ⏺ / ⎿ tree, and
 * a braille spinner with elapsed time.
 *
 * Zero dependencies — no ink, no blessed, no chalk. Those pull a React
 * reconciler or native deps onto a phone for what is ultimately a handful of
 * escape codes. Everything here is raw ANSI and box-drawing characters.
 *
 * Width is clamped to the terminal, floored at 44 and capped at 72: Termux on
 * a phone is usually 50-something columns, and a box wider than the screen
 * wraps into garbage.
 */

import process from 'node:process';

export const width = () => Math.max(44, Math.min(72, process.stdout.columns || 50));

/* ---------- colour ---------- */

const code = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;

export const C = {
  dim: code(2),
  bold: code(1),
  italic: code(3),
  amber: (s) => `\x1b[38;5;179m${s}\x1b[0m`,
  sky: (s) => `\x1b[38;5;110m${s}\x1b[0m`,
  green: (s) => `\x1b[38;5;108m${s}\x1b[0m`,
  red: (s) => `\x1b[38;5;174m${s}\x1b[0m`,
  grey: (s) => `\x1b[38;5;245m${s}\x1b[0m`,
  inverse: code(7),
};

/** Visible length, ignoring ANSI escapes — needed for padding inside boxes. */
export const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

export function pad(s, n) {
  const gap = n - visible(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

/**
 * Truncate to n visible columns, keeping ANSI codes intact — a naive slice
 * would cut a colour escape in half and bleed styling into the rest of the
 * line. Reset is appended if any styling was still open at the cut.
 */
export function clip(s, n) {
  if (visible(s) <= n) return s;
  let out = '';
  let seen = 0;
  let styled = false;
  const re = /(\x1b\[[0-9;]*m)|([\s\S])/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) {
      out += m[1];
      styled = m[1] !== '\x1b[0m';
    } else {
      if (seen >= n - 1) break;
      out += m[2];
      seen++;
    }
  }
  return out + '…' + (styled ? '\x1b[0m' : '');
}

/** Wrap to a column count, preserving existing newlines. */
export function wrap(text, cols) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!para.trim()) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!line) line = word;
      else if (visible(line) + 1 + visible(word) <= cols) line += ' ' + word;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/* ---------- boxes ---------- */

const B = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };

/**
 * A rounded box. `title` sits in the top border; `lines` may contain ANSI.
 * colour is applied to the border only, so content keeps its own styling.
 */
export function box(lines, { title = '', colour = C.grey, w = width() } = {}) {
  const inner = w - 4;
  const head = title
    ? `${B.tl}${B.h} ${title} ${B.h.repeat(Math.max(0, inner - visible(title) - 1))}${B.tr}`
    : `${B.tl}${B.h.repeat(w - 2)}${B.tr}`;

  // Clip anything longer than the box rather than letting it push the right
  // border out of alignment. Callers should wrap() first; this is the backstop.
  const body = lines.map((l) => `${colour(B.v)} ${pad(clip(l, inner), inner)} ${colour(B.v)}`);
  const foot = `${B.bl}${B.h.repeat(w - 2)}${B.br}`;
  return [colour(head), ...body, colour(foot)].join('\n');
}

/** The startup banner. */
export function banner({ cwd, model, source, free }) {
  const w = width();
  const tag = free ? C.green(' free') : '';
  return box(
    [
      `${C.amber('✻')} ${C.bold('termux-code')}`,
      '',
      `${C.dim('model')}  ${model}${tag}`,
      `${C.dim('via')}    ${source}`,
      `${C.dim('cwd')}    ${cwd}`,
    ],
    { colour: C.grey, w }
  );
}

/* ---------- the tool-call tree ---------- */

/** ⏺ a tool about to run, with its most identifying argument. */
export function toolHeader(name, arg) {
  return `${C.amber('⏺')} ${C.bold(name)}${arg ? C.dim('(' + arg + ')') : ''}`;
}

/**
 * ⎿ the result underneath it. Long output is collapsed to a line count the
 * way Claude Code does — the full text still goes to the model, this is only
 * what the human sees, and a 400-line file dump would bury the conversation.
 */
export function toolResult(text, { ok = true, max = 6 } = {}) {
  const cols = width() - 6;
  const all = String(text).split('\n').filter((l) => l.length);
  const tint = ok ? C.dim : C.red;

  // Truncated, never wrapped. Tool output is mostly code and directory
  // listings, where leading whitespace carries meaning — reflowing it turns
  // an indented block into misleading flat text, and splitting one source
  // line across two rows breaks the line numbers read_file just added.
  const rows = all.slice(0, max).map((l) => {
    const flat = l.replace(/\t/g, '  ');
    return flat.length > cols ? flat.slice(0, cols - 1) + '…' : flat;
  });

  const out = rows.map((l, i) => `  ${C.grey(i === 0 ? '⎿' : ' ')}  ${tint(l)}`);
  if (all.length > rows.length) {
    out.push(`  ${C.grey(' ')}  ${C.dim(`… +${all.length - rows.length} more lines`)}`);
  }
  return out.join('\n');
}

/* ---------- spinner ---------- */

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * A spinner that reports elapsed seconds, so a slow free-tier model doesn't
 * look like a hang. Writes to stderr and clears its own line, so piping
 * stdout stays clean.
 */
export function spinner(label = 'Thinking') {
  if (!process.stderr.isTTY) return { stop() {} };
  let i = 0;
  const started = Date.now();
  const tick = () => {
    const secs = Math.floor((Date.now() - started) / 1000);
    const frame = C.amber(FRAMES[i++ % FRAMES.length]);
    process.stderr.write(`\r${frame} ${C.dim(label)} ${C.grey(secs + 's')}  ${C.dim('esc to stop')}`);
  };
  tick();
  const id = setInterval(tick, 90);
  return {
    stop() {
      clearInterval(id);
      process.stderr.write('\r\x1b[2K');
    },
  };
}

/* ---------- interactive list picker ---------- */

/**
 * A scrolling, filterable picker. Arrow keys or j/k move, typing filters,
 * enter selects, escape cancels. Falls back to a plain numbered prompt when
 * stdin isn't a TTY (piped input, some Termux setups).
 *
 * @param {Array<{label:string, meta?:string, badge?:string, disabled?:boolean}>} items
 */
export function pick(items, { title = 'Select', current = -1, ask } = {}) {
  if (!process.stdin.isTTY) return pickFallback(items, { title, current, ask });

  return new Promise((resolve) => {
    const w = width();
    const rows = Math.max(5, Math.min(10, (process.stdout.rows || 24) - 10));
    let filter = '';
    let cursor = current >= 0 ? current : 0;
    let top = 0;
    let painted = 0;

    const matching = () => {
      const n = filter.toLowerCase();
      return items
        .map((it, i) => ({ ...it, i }))
        .filter((it) => !n || (it.label + ' ' + (it.meta || '')).toLowerCase().includes(n));
    };

    function paint() {
      if (painted) process.stdout.write(`\x1b[${painted}A\x1b[0J`);
      const list = matching();
      if (cursor >= list.length) cursor = Math.max(0, list.length - 1);
      if (cursor < top) top = cursor;
      if (cursor >= top + rows) top = cursor - rows + 1;

      const out = [];
      out.push(C.grey(`╭${'─'} ${title} ${'─'.repeat(Math.max(0, w - visible(title) - 5))}╮`));

      const slice = list.slice(top, top + rows);
      if (!slice.length) out.push(`${C.grey('│')} ${pad(C.dim('no match'), w - 4)} ${C.grey('│')}`);

      slice.forEach((it, n) => {
        const idx = top + n;
        const on = idx === cursor;
        const mark = on ? C.amber('❯') : ' ';
        const dot = it.i === current ? C.amber('●') : C.grey('○');
        let label = it.disabled ? C.dim(it.label) : on ? C.bold(it.label) : it.label;
        if (it.badge) label += ' ' + C.green(it.badge);
        out.push(`${C.grey('│')} ${pad(`${mark} ${dot} ${label}`, w - 4)} ${C.grey('│')}`);
        if (it.meta) out.push(`${C.grey('│')} ${pad('    ' + C.dim(it.meta), w - 4)} ${C.grey('│')}`);
      });

      const pos = list.length ? `${cursor + 1}/${list.length}` : '0/0';
      out.push(C.grey(`╰${'─'.repeat(w - 2)}╯`));
      out.push(
        `${C.dim('filter')} ${filter || C.dim('(type to search)')}   ${C.dim(pos)}`
      );
      out.push(C.dim('↑↓ move · enter select · esc cancel'));

      const text = out.join('\n');
      process.stdout.write(text + '\n');
      painted = text.split('\n').length;
    }

    const onKey = (chunk) => {
      const s = chunk.toString();
      const list = matching();

      if (s === '\u0003' || s === '\u001b') return done(null); // ctrl-c / esc
      if (s === '\r' || s === '\n') return done(list[cursor] ? list[cursor].i : null);
      if (s === '\u001b[A' || s === 'k') cursor = Math.max(0, cursor - 1);
      else if (s === '\u001b[B' || s === 'j') cursor = Math.min(list.length - 1, cursor + 1);
      else if (s === '\u007f') filter = filter.slice(0, -1);
      else if (s >= ' ' && s.length === 1) {
        filter += s;
        cursor = 0;
        top = 0;
      }
      paint();
    };

    function done(value) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onKey);
      if (painted) process.stdout.write(`\x1b[${painted}A\x1b[0J`);
      resolve(value);
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onKey);
    paint();
  });
}

/** Numbered prompt for non-TTY stdin. `ask` comes from the caller's readline. */
async function pickFallback(items, { title, current, ask }) {
  if (!ask) return null;
  console.log('\n' + C.bold(title));
  items.slice(0, 60).forEach((it, i) => {
    const dot = i === current ? C.amber('●') : ' ';
    console.log(`${dot} ${String(i + 1).padStart(2)}  ${it.label}${it.badge ? C.green(' ' + it.badge) : ''}`);
    if (it.meta) console.log(`       ${C.dim(it.meta)}`);
  });
  const answer = ((await ask('\nnumber, or enter to keep current: ')) ?? '').trim();
  if (!answer) return null;
  const n = Number(answer) - 1;
  return Number.isInteger(n) && items[n] ? n : null;
}

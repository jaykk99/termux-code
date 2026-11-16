/**
 * Command-line surface for termux-code.
 *
 * Kept out of bin/termux-code.mjs so it can be tested without starting the
 * REPL, touching ~/.termux-code, or reaching the network: the parser is a
 * pure function, and the approval policy is one small decision function.
 *
 * The CLI shipped with no argument handling at all — `--help` and
 * `--version` started a full interactive session and printed nothing
 * useful — so everything here is additive: with no arguments the REPL
 * behaves exactly as before.
 */

export const USAGE = `termux-code — a coding agent for Termux

Usage
  termux-code                      start the interactive session
  termux-code -p "<prompt>"        run one prompt, print the answer, exit
  echo "<prompt>" | termux-code    same, with the prompt on stdin
  termux-code --help               this text
  termux-code --version            print the version

Options
  -p, --print <text>    one-shot: run this prompt and exit (no REPL)
  -y, --yes             approve every tool call without asking (writes and
                        shell commands included — use it deliberately)
  -m, --model <id>      start on this model (id or label substring)
  -C, --cwd <dir>       workspace root (default: the current directory)
  -n, --max-steps <n>   tool steps allowed per turn (default: 40)
      --session <id>    one-shot into an existing session and save it
      --json            one-shot: one JSON object on stdout (the run's
                        traces are diverted to stderr, so it pipes cleanly)
      --                everything after this is the prompt

In one-shot mode nothing is written to ~/.termux-code/sessions unless
--session is given, and tool calls that would write files or run a shell
command are DECLINED unless --yes is passed: an unattended run must not
edit the phone unsupervised.

Inside the REPL, /help lists the slash commands.`;

/** Split `--flag=value` into [flag, value] once; plain flags stay whole. */
function splitFlag(arg) {
  if (!arg.startsWith('--')) return [arg, null];
  const eq = arg.indexOf('=');
  if (eq === -1) return [arg, null];
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

/**
 * Parse argv (already sliced past node + script).
 * @returns {{help:boolean, version:boolean, prompt:string|null, model:string|null,
 *   cwd:string|null, yes:boolean, json:boolean, session:string|null,
 *   maxSteps:number|null, error:string|null}}
 */
export function parseArgs(argv = []) {
  const opts = {
    help: false,
    version: false,
    prompt: null,
    model: null,
    cwd: null,
    yes: false,
    json: false,
    session: null,
    maxSteps: null,
    error: null,
  };
  const words = [];

  const takeValue = (flag, inlineValue, index) => {
    if (inlineValue !== null && inlineValue !== undefined) {
      if (inlineValue === '') {
        opts.error = `${flag} needs a value`;
        return [null, index];
      }
      return [inlineValue, index];
    }
    const next = argv[index + 1];
    if (next === undefined) {
      opts.error = `${flag} needs a value`;
      return [null, index];
    }
    return [next, index + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    if (arg === '--') {
      words.push(...argv.slice(i + 1).map(String));
      break;
    }
    const [flag, inline] = splitFlag(arg);
    switch (flag) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-v':
      case '--version':
        opts.version = true;
        break;
      case '-y':
      case '--yes':
        opts.yes = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '-p':
      case '--print': {
        const [value, consumed] = takeValue(flag, inline, i);
        if (value === null) return opts;
        opts.prompt = value;
        i = consumed;
        break;
      }
      case '-m':
      case '--model': {
        const [value, consumed] = takeValue(flag, inline, i);
        if (value === null) return opts;
        opts.model = value;
        i = consumed;
        break;
      }
      case '-C':
      case '--cwd': {
        const [value, consumed] = takeValue(flag, inline, i);
        if (value === null) return opts;
        opts.cwd = value;
        i = consumed;
        break;
      }
      case '--session': {
        const [value, consumed] = takeValue(flag, inline, i);
        if (value === null) return opts;
        opts.session = value;
        i = consumed;
        break;
      }
      case '-n':
      case '--max-steps': {
        const [value, consumed] = takeValue(flag, inline, i);
        if (value === null) return opts;
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          opts.error = `${flag} needs a positive whole number, got ${JSON.stringify(value)}`;
          return opts;
        }
        opts.maxSteps = n;
        i = consumed;
        break;
      }
      default:
        if (arg.startsWith('-') && arg !== '-') {
          opts.error = `unknown option ${arg}`;
          return opts;
        }
        words.push(arg);
    }
  }

  // A bare first argument is a prompt: `termux-code "add a test"` should do
  // the obvious thing rather than opening the REPL and ignoring the words.
  if (!opts.prompt && words.length) opts.prompt = words.join(' ');
  return opts;
}

/**
 * How tool approval should behave for this run.
 *  'ask'   — interactive prompt (the original behaviour)
 *  'allow' — --yes, everything is approved
 *  'deny'  — unattended without --yes: only reads run
 */
export function approvalModeFor(opts = {}) {
  if (opts.yes) return 'allow';
  return opts.prompt ? 'deny' : 'ask';
}

/** The one-line note printed when an unattended run declines a tool. */
export function deniedNote(desc) {
  return `declined (${desc}): an unattended run only reads. Pass --yes to allow writes and shell commands.`;
}

/** Find a model by exact id, then by case-insensitive label/id substring. */
export function pickModel(models = [], wanted) {
  if (!wanted) return null;
  const needle = String(wanted).toLowerCase();
  const exact = models.find((m) => m.id === wanted);
  if (exact) return exact;
  const byId = models.find((m) => String(m.id).toLowerCase() === needle);
  if (byId) return byId;
  const byLabel = models.find((m) => String(m.label || '').toLowerCase().includes(needle));
  if (byLabel) return byLabel;
  return models.find((m) => String(m.id).toLowerCase().includes(needle)) || null;
}

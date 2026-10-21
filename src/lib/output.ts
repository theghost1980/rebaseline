import { confirm, isCancel } from '@clack/prompts';
import { createColors } from 'picocolors';

/*
 * Terminal output.
 *
 * Windows PowerShell 5.1 decodes redirected child output with the OEM code
 * page, so any non-ASCII byte we print turns into garbage there. Fancy symbols
 * and colors are only used when the stream we write to is an interactive
 * terminal; everything else gets plain ASCII.
 */

const env = process.env;

function colorEnabled(stream: NodeJS.WriteStream): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  return Boolean(stream.isTTY) && env.TERM !== 'dumb';
}

/** Same heuristic as @clack/prompts, plus a TTY check of the stream we write to. */
function unicodeEnabled(stream: NodeJS.WriteStream): boolean {
  if (!stream.isTTY) return false;
  if (process.platform !== 'win32') return env.TERM !== 'linux';
  return Boolean(
    env.WT_SESSION ||
      env.TERMINUS_SUBLIME ||
      env.ConEmuTask === '{cmd::Cmder}' ||
      env.TERM_PROGRAM === 'vscode' ||
      env.TERM === 'xterm-256color' ||
      env.TERM === 'alacritty' ||
      env.TERMINAL_EMULATOR === 'JetBrains-JediTerm',
  );
}

export const interactive = Boolean(process.stdout.isTTY);
export const color = createColors(colorEnabled(process.stdout));
const errColor = createColors(colorEnabled(process.stderr));

const sym = unicodeEnabled(process.stdout)
  ? { step: '●', ok: '✔', warn: '▲', bullet: '•', spinner: ['◒', '◐', '◓', '◑'] }
  : { step: '*', ok: '+', warn: '!', bullet: '-', spinner: ['-', '\\', '|', '/'] };
// stdout and stderr can be redirected separately, so errors check their own stream.
const errSym = unicodeEnabled(process.stderr) ? '✖' : 'x';

export const bullet = sym.bullet;

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

export const log = {
  /** A line with no prefix. */
  plain(message = ''): void {
    write(message);
  },
  step(message: string): void {
    write(`${color.cyan(sym.step)} ${message}`);
  },
  success(message: string): void {
    write(`${color.green(sym.ok)} ${message}`);
  },
  warn(message: string, hint?: string): void {
    write(`${color.yellow(sym.warn)} ${message}`);
    if (hint) write(`  ${color.dim(hint)}`);
  },
  error(message: string, hint?: string, details?: string): void {
    process.stderr.write(`${errColor.red(errSym)} ${message}\n`);
    if (hint) process.stderr.write(`  ${hint}\n`);
    if (details) process.stderr.write(`\n${details.replace(/\n$/, '')}\n`);
  },
};

/** True when the user can answer questions here. */
export const canAsk = Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Asks a yes/no question; "no" is the default. Only call it when canAsk is true. */
export async function askYesNo(question: string): Promise<boolean> {
  const answer = await confirm({ message: question, initialValue: false });
  return !isCancel(answer) && answer === true;
}

/**
 * Shows a spinner while `task` runs, in interactive terminals only. It only
 * writes: a spinner that also reads the keyboard puts the terminal in raw mode,
 * and on Windows that turns Ctrl+C into a plain key press.
 */
export async function withSpinner<T>(message: string, task: () => Promise<T>): Promise<T> {
  if (!interactive) return task();
  let frame = 0;
  const draw = () => process.stdout.write(`\r${color.cyan(sym.spinner[frame++ % sym.spinner.length] ?? '')} ${message}`);
  draw();
  const timer = setInterval(draw, 100);
  try {
    return await task();
  } finally {
    clearInterval(timer);
    // Back to the start of the line and clear it.
    process.stdout.write('\r\x1b[2K');
  }
}

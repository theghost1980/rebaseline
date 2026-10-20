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
  ? { step: '●', ok: '✔', warn: '▲', bullet: '•' }
  : { step: '*', ok: '+', warn: '!', bullet: '-' };
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
  error(message: string, hint?: string): void {
    process.stderr.write(`${errColor.red(errSym)} ${message}\n`);
    if (hint) process.stderr.write(`  ${hint}\n`);
  },
};

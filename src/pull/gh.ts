import { execFile } from 'node:child_process';
import { UserError } from '../lib/errors.js';

export interface GhOptions {
  cwd: string;
  /** Error for a "not found" answer, which GitHub also gives when the account cannot see the repository. */
  notFound?: () => UserError;
  /** What the call reads, for permission errors: "the Actions runs of octo/site". */
  what?: string;
  signal?: AbortSignal;
}

/** Keeps gh from prompting, checking for updates or adding colors. */
const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1' };

/**
 * The program that runs gh. REBASELINE_GH points at a JavaScript file that
 * replaces gh, run with Node; the tests use it because Windows cannot run a
 * stand-in .cmd file without a shell.
 */
function ghCommand(args: string[]): [string, string[]] {
  const stub = process.env.REBASELINE_GH;
  return stub ? [process.execPath, [stub, ...args]] : ['gh', args];
}

/** Runs the GitHub CLI and returns its output. Failures become errors the user can act on. */
export function runGh(args: string[], options: GhOptions): Promise<string> {
  const [file, fileArgs] = ghCommand(args);
  return new Promise((resolve, reject) => {
    execFile(
      file,
      fileArgs,
      {
        cwd: options.cwd,
        env: { ...process.env, ...GH_ENV },
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        signal: options.signal,
      },
      (err, stdout, stderr) => (err ? reject(ghError(err, stderr, args, options)) : resolve(stdout)),
    );
  });
}

/** Runs gh and parses its JSON output. */
export async function ghJson<T>(args: string[], options: GhOptions): Promise<T> {
  const out = await runGh(args, options);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new UserError(`gh ${args.slice(0, 2).join(' ')} returned output that is not JSON`, 'Update the GitHub CLI (gh) and try again.');
  }
}

function ghError(err: { code?: string | number | null; name?: string; message: string }, stderr: string, args: string[], options: GhOptions): Error {
  if (err.name === 'AbortError') return err as Error;
  if (err.code === 'ENOENT') {
    return new UserError('The GitHub CLI (gh) was not found', 'Install it from https://cli.github.com, then sign in with "gh auth login".');
  }
  const text = stderr.trim();
  // gh exits with 4 when it has no credentials.
  if (err.code === 4 || /gh auth login/.test(text)) {
    return new UserError('The GitHub CLI (gh) is not signed in', 'Run "gh auth login", or set GH_TOKEN to a token that can read this repository.');
  }
  if (/HTTP 401|Bad credentials/i.test(text)) {
    return new UserError('GitHub rejected the credentials of the GitHub CLI (gh)', 'Run "gh auth login" again, or check the GH_TOKEN variable.');
  }
  if (/rate limit/i.test(text)) {
    return new UserError('GitHub API rate limit reached', 'Wait a few minutes and try again.');
  }
  if (/Resource not accessible by|HTTP 403/i.test(text)) {
    return new UserError(
      `The GitHub token cannot read ${options.what ?? 'this information'}`,
      'Give it read access to Actions (and to Pull requests for --pr), or sign in with "gh auth login".',
    );
  }
  if (options.notFound && /HTTP 404|Not Found|Could not resolve to a/i.test(text)) return options.notFound();
  // Older versions also lack some --json fields, such as "attempt" of gh run list.
  if (/unknown (shorthand )?flag|unknown command|unknown JSON field/i.test(text)) {
    return new UserError('This version of the GitHub CLI (gh) is too old', 'Update it from https://cli.github.com and try again.');
  }
  const detail = text.split(/\r?\n/).find((line) => line.trim() !== '') ?? err.message;
  return new UserError(`gh ${args.slice(0, 2).join(' ')} failed: ${detail}`, `Run "gh ${args.join(' ')}" to see the full message.`);
}

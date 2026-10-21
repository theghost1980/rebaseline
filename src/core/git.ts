import { execFile } from 'node:child_process';
import path from 'node:path';
import { UserError } from '../lib/errors.js';
import { displayPath } from '../lib/paths.js';

/** Folders that hold test output, never baselines. */
const OUTPUT_DIRS = new Set(['test-results', 'playwright-report']);

export function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(gitError(err, stderr, args, cwd)) : resolve(stdout)),
    );
  });
}

function gitError(err: { code?: string | number | null; message: string }, stderr: string, args: string[], cwd: string): UserError {
  if (err.code === 'ENOENT') {
    return new UserError('git was not found', 'Install git and make sure the git command works in this terminal.');
  }
  if (/not a git repository/i.test(stderr)) {
    return new UserError(`${displayPath(cwd)} is not inside a git repository`, 'Run rebaseline from your project folder.');
  }
  if (/dubious ownership/i.test(stderr)) {
    return new UserError(
      'git refuses to read this repository (dubious ownership)',
      'Run the "git config --global --add safe.directory" command that git suggests, then try again.',
    );
  }
  const detail = stderr.trim().split(/\r?\n/)[0] || err.message;
  return new UserError(`git ${args[0] ?? ''} failed: ${detail}`);
}

/** Absolute path of the repository that contains `cwd`. */
export async function repoRoot(cwd: string): Promise<string> {
  return path.resolve((await runGit(['rev-parse', '--show-toplevel'], cwd)).trim());
}

/**
 * Tracked PNG files under `cwd`, as paths relative to the repository root with
 * forward slashes. Files inside test output folders are left out.
 */
export async function listTrackedPngs(cwd: string): Promise<string[]> {
  return listPngs(cwd, []);
}

/** Like listTrackedPngs(), for files git does not track and does not ignore. */
export async function listUntrackedPngs(cwd: string): Promise<string[]> {
  return listPngs(cwd, ['--others', '--exclude-standard']);
}

async function listPngs(cwd: string, flags: string[]): Promise<string[]> {
  const out = await runGit(['-c', 'core.quotepath=off', 'ls-files', '-z', '--full-name', ...flags, '--', '*.png', '*.PNG'], cwd);
  return out
    .split('\0')
    .filter(Boolean)
    .filter((file) => !file.split('/').some((segment) => OUTPUT_DIRS.has(segment)));
}

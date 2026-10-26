import path from 'node:path';
import { runGit } from '../core/git.js';
import { gitLfsInstalled } from '../core/lfs.js';
import { plural } from '../lib/format.js';
import { bullet, color, log } from '../lib/output.js';
import { realPathOf, toPosix } from '../lib/paths.js';
import type { SessionResults } from './session.js';

/** Double quotes work the same in bash, zsh, PowerShell and cmd for the usual file names. */
function quoteForShell(p: string): string {
  return /^[\w./@+-]+$/.test(p) ? p : `"${p}"`;
}

/** Prints what the review changed, with git's view of the written files. */
export async function printSummary(
  results: SessionResults,
  root: string,
  hasGitLfs: (cwd: string) => Promise<boolean> = gitLfsInstalled,
): Promise<void> {
  const { accepted, rejected, pending } = results;
  log.plain();
  log.success(`Review finished: ${accepted.length} accepted, ${rejected} rejected, ${pending} not reviewed.`);

  if (accepted.length === 0) {
    log.plain('  No files were written.');
    return;
  }

  const targets = accepted.map((a) => a.target);
  let status: string[] = [];
  try {
    // Same format as --short, without colors or quoting.
    const out = await runGit(
      ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...targets.map((t) => `:(literal)${t}`)],
      root,
    );
    status = out.split('\0').filter((line) => line.trim() !== '');
  } catch {
    // Without git status, still list the files.
  }

  log.plain(`  Files written (git status --short):`);
  const listed = new Set<string>();
  for (const line of status) {
    log.plain(`    ${line}`);
    listed.add(line.slice(3));
  }
  for (const target of targets) {
    if (!listed.has(target)) log.plain(`    ${color.dim(`${bullet} ${target} (same content as the committed file)`)}`);
  }

  // Ready to copy, relative to the current folder, which may be below the repository root.
  const changed = targets.filter((t) => listed.has(t));
  if (changed.length > 0) {
    const cwd = realPathOf(process.cwd());
    const paths = changed.map((t) => quoteForShell(toPosix(path.relative(cwd, path.join(root, t)))));
    log.plain('  Stage them for a commit:');
    log.plain(`    git add -- ${paths.join(' ')}`);
  }

  const lfs = accepted.filter((a) => a.lfs).length;
  if (lfs > 0 && !(await hasGitLfs(root))) {
    log.warn(
      `${plural(lfs, 'accepted file')} ${lfs === 1 ? 'is' : 'are'} stored with Git LFS, but git-lfs is not installed.`,
      'Install it (https://git-lfs.com) before committing, or the images go into git instead of LFS.',
    );
  }
}

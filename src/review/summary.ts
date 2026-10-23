import { runGit } from '../core/git.js';
import { gitLfsInstalled } from '../core/lfs.js';
import { plural } from '../lib/format.js';
import { bullet, color, log } from '../lib/output.js';
import type { SessionResults } from './session.js';

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

  const lfs = accepted.filter((a) => a.lfs).length;
  if (lfs > 0 && !(await hasGitLfs(root))) {
    log.warn(
      `${plural(lfs, 'accepted file')} ${lfs === 1 ? 'is' : 'are'} stored with Git LFS, but git-lfs is not installed.`,
      'Install it (https://git-lfs.com) before committing, or the images go into git instead of LFS.',
    );
  }
}

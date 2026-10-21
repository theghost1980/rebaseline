import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runGit } from '../core/git.js';
import { checkTarget, deleteNewBaseline } from '../core/writer.js';
import { errorMessage } from '../lib/errors.js';
import { log } from '../lib/output.js';

export interface RejectedNew {
  target: string;
  /** SHA-1 of the reported image; the file must still have exactly this content. */
  sha1: string;
}

/**
 * Rejected new screenshots that are still on disk with the reported content and
 * that git neither tracks nor has staged. Anything uncertain is left out.
 */
export async function findRemovable(root: string, rejected: RejectedNew[]): Promise<RejectedNew[]> {
  const out: RejectedNew[] = [];
  for (const item of rejected) {
    try {
      const { file } = await checkTarget(root, item.target);
      const sha1 = createHash('sha1').update(await readFile(file)).digest('hex');
      if (sha1 === item.sha1 && !(await knownToGit(root, item.target))) out.push(item);
    } catch {
      // Missing, unreadable or not a safe path: never offered for deletion.
    }
  }
  return out;
}

/** True when the file is tracked or staged, or when git cannot tell. */
async function knownToGit(root: string, target: string): Promise<boolean> {
  try {
    return (await runGit(['ls-files', '-z', '--', `:(literal)${target}`], root)) !== '';
  } catch {
    return true;
  }
}

/**
 * Lists the rejected new screenshots left on disk and, when `ask` is given,
 * offers to delete them. Each file is checked again right before deleting it.
 */
export async function offerCleanup(root: string, rejected: RejectedNew[], ask?: (question: string) => Promise<boolean>): Promise<void> {
  const removable = await findRemovable(root, rejected);
  if (removable.length === 0) return;

  const one = removable.length === 1;
  log.plain();
  log.warn(`${one ? 'A new screenshot you rejected is' : `${removable.length} new screenshots you rejected are`} still on disk, not tracked by git:`);
  for (const item of removable) log.plain(`    ${item.target}`);

  if (!ask) {
    log.plain('  Delete them yourself if you do not want them.');
    return;
  }
  if (!(await ask(one ? 'Delete this file?' : `Delete these ${removable.length} files?`))) {
    log.plain('  Kept them.');
    return;
  }
  for (const item of removable) {
    if ((await findRemovable(root, [item])).length === 0) {
      log.warn(`Skipped ${item.target}: it changed or git tracks it now.`);
      continue;
    }
    try {
      await deleteNewBaseline(root, item.target, item.sha1);
      log.success(`Deleted ${item.target}`);
    } catch (err) {
      log.error(errorMessage(err));
    }
  }
}

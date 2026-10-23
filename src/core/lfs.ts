import { runGit } from './git.js';

/*
 * Git LFS keeps large files out of git: the repository stores a small text
 * pointer with the SHA-256 of the real file. Without "git lfs pull" (or
 * without git-lfs installed) the working tree holds the pointers, not the
 * images, so baselines are also matched by that SHA-256.
 */

/** First line of every Git LFS pointer. */
const POINTER_VERSION = 'version https://git-lfs.github.com/spec/v1';
/** Git LFS never writes pointers larger than this. */
const MAX_POINTER_SIZE = 1024;

/** The SHA-256 of the real file when `data` is a Git LFS pointer, or null. */
export function lfsPointerOid(data: Buffer): string | null {
  if (data.length > MAX_POINTER_SIZE) return null;
  const text = data.toString('utf8');
  if (!text.startsWith(POINTER_VERSION)) return null;
  return /^oid sha256:([0-9a-f]{64})\r?$/m.exec(text)?.[1] ?? null;
}

/** True when the git-lfs command works. */
export async function gitLfsInstalled(cwd: string): Promise<boolean> {
  try {
    await runGit(['lfs', 'version'], cwd);
    return true;
  } catch {
    return false;
  }
}

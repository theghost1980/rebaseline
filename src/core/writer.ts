import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { UserError } from '../lib/errors.js';
import { isInside, toPosix } from '../lib/paths.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type WriterErrorCode = 'invalid-path' | 'outside-repo' | 'not-png' | 'not-a-file' | 'bad-source' | 'io';

export class WriterError extends UserError {
  readonly code: WriterErrorCode;

  constructor(code: WriterErrorCode, message: string, hint?: string) {
    super(message, hint);
    this.name = 'WriterError';
    this.code = code;
  }
}

export interface WriteResult {
  /** Path relative to the repository root, with forward slashes. */
  target: string;
  /** Absolute path that was written. */
  file: string;
  /** True when the file did not exist before. */
  created: boolean;
  /** Previous content, to put it back with restoreBaseline(). Null when the file was created. */
  previous: Buffer | null;
}

/**
 * Copies the PNG at `source` to `target` (relative to `root`). Only PNG files
 * inside the repository are written; missing folders are created.
 */
export async function writeBaseline(root: string, target: string, source: string): Promise<WriteResult> {
  const { file, rel } = await checkTarget(root, target);
  const data = await readSource(source);
  const previous = await readExisting(file, rel);
  await mkdir(path.dirname(file), { recursive: true });
  // The folders may have just been created: check again that nothing points outside the repository.
  await checkTarget(root, target);
  await writeAtomic(file, data, rel);
  return { target: rel, file, created: previous === null, previous };
}

/** Puts back the content returned by writeBaseline() in `previous`. */
export async function restoreBaseline(root: string, target: string, previous: Buffer): Promise<void> {
  const { file, rel } = await checkTarget(root, target);
  if (!previous.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new WriterError('bad-source', `Refusing to restore ${rel}: the saved content is not a PNG image`);
  }
  await writeAtomic(file, previous, rel);
}

/**
 * Deletes one PNG file inside the repository, only while its content is still
 * exactly `sha1`. Used to remove a new screenshot the user rejected; the caller
 * must make sure git does not track the file.
 */
export async function deleteNewBaseline(root: string, target: string, sha1: string): Promise<void> {
  const { file, rel } = await checkTarget(root, target);
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch (err) {
    throw ioError(rel, err);
  }
  if (createHash('sha1').update(data).digest('hex') !== sha1) {
    throw new WriterError('bad-source', `Not deleting ${rel}: it changed after the review`);
  }
  try {
    await unlink(file);
  } catch (err) {
    throw ioError(rel, err);
  }
}

/** Validates a repository-relative target and returns its absolute path. */
export async function checkTarget(root: string, target: string): Promise<{ file: string; rel: string }> {
  const raw = toPosix(target.trim());
  if (raw === '' || raw.includes('\0') || path.posix.isAbsolute(raw) || path.win32.isAbsolute(target) || /^[A-Za-z]:/.test(raw)) {
    throw new WriterError('invalid-path', `Refusing to write "${target}": not a path inside the repository`);
  }
  const segments = raw.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new WriterError('invalid-path', `Refusing to write "${target}": the path must not contain "." or ".." segments`);
  }
  if (segments.some((s) => s.toLowerCase() === '.git')) {
    throw new WriterError('invalid-path', `Refusing to write "${target}": it is inside the .git folder`);
  }
  if (path.posix.extname(raw).toLowerCase() !== '.png') {
    throw new WriterError('not-png', `Refusing to write "${target}": only .png files can be written`);
  }

  const rootAbs = path.resolve(root);
  const file = path.resolve(rootAbs, ...segments);
  if (!isInside(rootAbs, file)) {
    throw new WriterError('outside-repo', `Refusing to write "${target}": it is outside the repository`);
  }

  // Follow links: the deepest existing folder must still be inside the real repository root.
  const realRoot = await realpath(rootAbs);
  let existing = path.dirname(file);
  while (!(await exists(existing)) && existing !== rootAbs) existing = path.dirname(existing);
  const realExisting = await realpath(existing);
  if (realExisting !== realRoot && !isInside(realRoot, realExisting)) {
    throw new WriterError('outside-repo', `Refusing to write "${target}": a folder in its path links outside the repository`);
  }

  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      throw new WriterError('outside-repo', `Refusing to write "${target}": it is a symbolic link`);
    }
    if (!info.isFile()) throw new WriterError('not-a-file', `Refusing to write "${target}": it is not a file`);
  } catch (err) {
    if (err instanceof WriterError) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw ioError(raw, err);
  }

  return { file, rel: segments.join('/') };
}

async function readSource(source: string): Promise<Buffer> {
  let data: Buffer;
  try {
    data = await readFile(source);
  } catch {
    throw new WriterError('bad-source', `Cannot read the screenshot ${source}`, 'The report may have been moved or deleted.');
  }
  if (!data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new WriterError('bad-source', `The screenshot ${source} is not a PNG image`);
  }
  return data;
}

async function readExisting(file: string, rel: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw ioError(rel, err);
  }
}

/** Writes next to the target and renames over it, so the file is never left half written. */
async function writeAtomic(file: string, data: Buffer, rel: string): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await open(tmp, 'wx');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmp, file);
  } catch (err) {
    // Only our own temporary file is removed; the target is left as it was.
    await rm(tmp, { force: true }).catch(() => undefined);
    throw ioError(rel, err);
  }
}

/** Windows can briefly lock a file that an antivirus or image viewer is reading. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function ioError(rel: string, err: unknown): WriterError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
    return new WriterError('io', `Could not write ${rel}: the file is in use or read-only`, 'Close any program that has it open and try again.');
  }
  return new WriterError('io', `Could not write ${rel} (${code ?? (err as Error).message})`);
}

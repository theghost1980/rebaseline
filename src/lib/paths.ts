import path from 'node:path';

/** Replaces backslashes with forward slashes. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** True when `child` is strictly inside `parent` (both absolute). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** A path for messages: relative to the current folder when it is below it. */
export function displayPath(p: string): string {
  const abs = path.resolve(p);
  const cwd = process.cwd();
  if (abs === cwd) return '.';
  return isInside(cwd, abs) ? path.relative(cwd, abs) : abs;
}

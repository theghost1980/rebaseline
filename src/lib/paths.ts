import { realpathSync } from 'node:fs';
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

/**
 * Real path of `p`: links are followed and Windows short names (RUNNER~1) are
 * expanded. Parts that do not exist yet are kept as they are.
 */
export function realPathOf(p: string): string {
  const abs = path.resolve(p);
  const missing: string[] = [];
  let current = abs;
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return abs;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** A path for messages: relative to the current folder when it is below it. */
export function displayPath(p: string): string {
  const abs = path.resolve(p);
  const cwd = process.cwd();
  if (abs === cwd) return '.';
  return isInside(cwd, abs) ? path.relative(cwd, abs) : abs;
}

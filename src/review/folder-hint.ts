import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { listTrackedPngs, repoRoot } from '../core/git.js';
import { type Baselines, indexFiles } from '../core/resolver.js';
import type { Report, Resolution, Shot } from '../core/types.js';
import { isInside, realPathOf } from '../lib/paths.js';

export interface FolderHint {
  /** The folder to run rebaseline from. */
  folder: string;
  /** "other-repo": the report was made in another repository; "outside-folder": the baselines are elsewhere in this one. */
  reason: 'other-repo' | 'outside-folder';
}

export interface FolderHintOptions {
  cwd: string;
  /** Folders whose files never count, as for loadBaselines(). */
  exclude: string[];
  /** The local report folder; reports downloaded by pull have none. */
  reportDir?: string;
}

/**
 * Where to run rebaseline from when no changed screenshot matched a baseline.
 * Baselines are only read under the current folder, so the usual cause is
 * running it from another folder: one next to the tests in the same
 * repository, or another repository. Returns null when nothing points to one.
 */
export async function suggestFolder(report: Report, resolutions: Map<string, Resolution>, baselines: Baselines, options: FolderHintOptions): Promise<FolderHint | null> {
  const changed = report.failures.flatMap((f) => f.shots).filter((s) => resolutions.get(s.id)?.kind === 'changed');
  const unmatched = (s: Shot) => {
    const r = resolutions.get(s.id);
    return r?.status === 'unresolved' && r.reason === 'no-match';
  };
  if (changed.length === 0 || !changed.every(unmatched)) return null;

  if (options.reportDir && !isInside(baselines.root, realPathOf(options.reportDir))) {
    const project = projectOf(options.reportDir);
    const root = await repoRoot(project).catch(() => null);
    if (root && realPathOf(root) !== baselines.root) return { folder: project, reason: 'other-repo' };
  }

  if (realPathOf(options.cwd) !== baselines.root) {
    const excluded = options.exclude.map(realPathOf);
    const files = (await listTrackedPngs(baselines.root)).filter((f) => !excluded.some((dir) => isInside(dir, path.join(baselines.root, f))));
    const index = await indexFiles(baselines.root, files);
    const found = changed.flatMap((s) => [
      ...(index.bySha1.get(s.expected?.sha1 ?? '') ?? []),
      ...(s.expected?.sha256 ? (index.byLfsOid.get(s.expected.sha256) ?? []) : []),
    ]);
    if (found.length > 0) {
      // The project of a local report is the best guess when its baselines are there; copies elsewhere do not matter.
      const project = options.reportDir ? projectOf(options.reportDir) : null;
      if (project && found.some((f) => isInside(project, path.join(baselines.root, f)))) return { folder: project, reason: 'outside-folder' };
      return { folder: await projectFolder(path.join(baselines.root, commonFolder(found)), baselines.root), reason: 'outside-folder' };
    }
  }
  return null;
}

/** The nearest folder at or above `folder`, up to `root`, with a Playwright config; otherwise `folder`. */
async function projectFolder(folder: string, root: string): Promise<string> {
  for (let dir = folder; ; dir = path.dirname(dir)) {
    const entries = await readdir(dir).catch(() => []);
    if (entries.some((name) => /^playwright\.config\.[cm]?[jt]s$/.test(name))) return dir;
    if (dir === root || path.dirname(dir) === dir) return folder;
  }
}

/** The project folder of a local report, when it is inside a git repository. */
export async function reportProject(reportDir: string): Promise<string | null> {
  const project = projectOf(reportDir);
  return (await repoRoot(project).catch(() => null)) ? project : null;
}

/** A local report sits in the project that made it, next to its playwright.config. */
function projectOf(reportDir: string): string {
  return path.dirname(path.resolve(reportDir));
}

/** The deepest folder that holds every file (paths relative to the root, with forward slashes). */
function commonFolder(files: string[]): string {
  const folders = files.map((f) => f.split('/').slice(0, -1));
  const [first = []] = folders;
  let depth = 0;
  while (depth < first.length && folders.every((f) => f[depth] === first[depth])) depth++;
  return first.slice(0, depth).join('/');
}

/** "cd <folder>", relative to `cwd` unless that climbs more than two folders, and quoted when it has spaces. */
export function cdCommand(folder: string, cwd: string): string {
  const rel = path.relative(cwd, folder) || '.';
  const climbs = rel.split(/[\\/]/).filter((s) => s === '..').length;
  const shown = climbs > 2 || path.isAbsolute(rel) ? folder : rel;
  return /\s/.test(shown) ? `cd "${shown}"` : `cd ${shown}`;
}

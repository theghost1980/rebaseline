import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isInside, realPathOf, toPosix } from '../lib/paths.js';
import { listTrackedPngs, listUntrackedPngs, repoRoot } from './git.js';
import { lfsPointerOid } from './lfs.js';
import type { Failure, Platform, Report, Resolution, ResolvedVia, Shot, ShotKind, UnresolvedReason } from './types.js';

export interface Baselines {
  /** Real absolute path of the repository root. */
  root: string;
  /** SHA-1 of the content -> paths relative to the root, with forward slashes. */
  index: Map<string, string[]>;
  /** SHA-256 of the real image -> tracked Git LFS pointers to it; used when no tracked file matches. */
  lfsIndex?: Map<string, string[]>;
  /** Same for PNG files git does not track and does not ignore; used only when nothing tracked matches. */
  untrackedIndex?: Map<string, string[]>;
}

export interface FileIndex {
  /** SHA-1 of the content -> paths. */
  bySha1: Map<string, string[]>;
  /** For Git LFS pointers: SHA-256 of the real file -> paths. */
  byLfsOid: Map<string, string[]>;
}

export interface LoadOptions {
  /** Folders whose files never count, such as the report being reviewed. */
  exclude?: string[];
}

/** Reads the PNG files under `cwd`: tracked ones, plus untracked ones that are not ignored. */
export async function loadBaselines(cwd: string, options: LoadOptions = {}): Promise<Baselines> {
  const root = realPathOf(await repoRoot(cwd));
  const excluded = (options.exclude ?? []).map(realPathOf);
  const keep = (file: string) => {
    const abs = path.join(root, file);
    return !excluded.some((dir) => isInside(dir, abs));
  };
  const [tracked, untracked] = await Promise.all([listTrackedPngs(cwd), listUntrackedPngs(cwd)]);
  const trackedIndex = await indexFiles(root, tracked.filter(keep));
  return {
    root,
    index: trackedIndex.bySha1,
    lfsIndex: trackedIndex.byLfsOid,
    untrackedIndex: await hashFiles(root, untracked.filter(keep)),
  };
}

/** SHA-1 of each file (paths relative to root). Missing files are skipped. */
export async function hashFiles(root: string, files: string[], concurrency = 16): Promise<Map<string, string[]>> {
  return (await indexFiles(root, files, concurrency)).bySha1;
}

/** SHA-1 of each file, plus the image SHA-256 of the files that are Git LFS pointers. Missing files are skipped. */
export async function indexFiles(root: string, files: string[], concurrency = 16): Promise<FileIndex> {
  const bySha1 = new Map<string, string[]>();
  const byLfsOid = new Map<string, string[]>();
  const add = (index: Map<string, string[]>, key: string, file: string) => {
    const list = index.get(key);
    if (list) list.push(file);
    else index.set(key, [file]);
  };
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++] as string;
      let data: Buffer;
      try {
        data = await readFile(path.join(root, file));
      } catch {
        continue;
      }
      add(bySha1, createHash('sha1').update(data).digest('hex'), file);
      const oid = lfsPointerOid(data);
      if (oid) add(byLfsOid, oid, file);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  for (const list of [...bySha1.values(), ...byLfsOid.values()]) list.sort();
  return { bySha1, byLfsOid };
}

/** Resolution of every shot in the report, by shot id. */
export function resolveReport(report: Report, baselines: Baselines): Map<string, Resolution> {
  const out = new Map<string, Resolution>();
  for (const failure of report.failures) {
    for (const shot of failure.shots) out.set(shot.id, resolveShot(failure, shot, baselines, report.platform));
  }
  return out;
}

/**
 * Decides which repository file an accepted screenshot replaces or creates.
 * `platform` is the system the report was made on, used as the last tie-break.
 */
export function resolveShot(failure: Pick<Failure, 'projectName'>, shot: Shot, baselines: Baselines, platform: Platform | null = null): Resolution {
  const kind: ShotKind = shot.missingPath !== null ? 'new' : 'changed';
  if (shot.actual.sha1 === null) return unresolved(kind, 'missing-image');

  if (shot.missingPath !== null) {
    const repoPath = toRepoPath(shot.missingPath, baselines.root);
    return 'path' in repoPath
      ? { status: 'resolved', kind, target: repoPath.path, via: 'path' }
      : unresolved(kind, repoPath.reason);
  }

  if (!shot.expected?.sha1) return unresolved(kind, 'no-expected-image');
  // Tracked files with the image, and Git LFS pointers to it, compete together:
  // a repository can have some images downloaded and others not.
  const tracked = baselines.index.get(shot.expected.sha1) ?? [];
  const lfs = shot.expected.sha256 ? (baselines.lfsIndex?.get(shot.expected.sha256) ?? []) : [];
  if (tracked.length + lfs.length > 0) {
    const result = choose([...new Set([...tracked, ...lfs])].sort(), 'tracked', failure, shot, platform);
    return result.status === 'resolved' && lfs.includes(result.target) ? { ...result, via: 'lfs' } : result;
  }
  const untracked = baselines.untrackedIndex?.get(shot.expected.sha1) ?? [];
  if (untracked.length > 0) return choose(untracked, 'untracked', failure, shot, platform);
  return unresolved(kind, 'no-match');
}

function choose(candidates: string[], via: ResolvedVia, failure: Pick<Failure, 'projectName'>, shot: Shot, platform: Platform | null): Resolution {
  const [only] = candidates;
  if (candidates.length === 1 && only) return { status: 'resolved', kind: 'changed', target: only, via };
  const narrowed = narrowCandidates(candidates, failure.projectName, shot.name);
  const [pick] = narrowed;
  if (narrowed.length === 1 && pick) return { status: 'resolved', kind: 'changed', target: pick, via };
  // Identical baselines of several operating systems: take the one of the system the report came from.
  const forPlatform = narrowed.length > 1 ? narrowToPlatform(narrowed, platform) : [];
  const [platformPick] = forPlatform;
  if (forPlatform.length === 1 && platformPick) return { status: 'resolved', kind: 'changed', target: platformPick, via };
  return unresolved('changed', 'ambiguous', narrowed.length > 0 ? narrowed : candidates);
}

/** The candidates whose path names `platform`, as in hero-chromium-linux.png or shots/linux/hero.png. */
export function narrowToPlatform(candidates: string[], platform: Platform | null): string[] {
  if (!platform) return [];
  const token = new RegExp(`(?:^|[/._-])${platform}(?:[/._-]|$)`, 'i');
  return candidates.filter((c) => token.test(c));
}

/** Keeps the candidates whose path mentions the project and whose file name starts with the screenshot name. */
export function narrowCandidates(candidates: string[], projectName: string, shotName: string): string[] {
  const projects = [...new Set([projectName, projectPathName(projectName)])].filter(Boolean);
  const name = lastSegment(shotName);
  return candidates.filter(
    (c) => lastSegment(c).startsWith(name) && (projects.length === 0 || projects.some((p) => c.includes(p))),
  );
}

/** How Playwright writes a project name inside snapshot paths. */
export function projectPathName(name: string): string {
  const sanitize = (s: string) => s.replace(/[\x00-\x2C\x2E-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g, '-');
  const dot = name.lastIndexOf('.');
  return dot === -1 ? sanitize(name) : `${sanitize(name.slice(0, dot))}.${sanitize(name.slice(dot + 1))}`;
}

const RUNNER_WORKSPACES = [
  /^\/home\/runner\/work\/([^/]+)\/([^/]+)\/(.+)$/, // Linux
  /^\/Users\/runner\/work\/([^/]+)\/([^/]+)\/(.+)$/, // macOS
  /^[A-Za-z]:\/a\/([^/]+)\/([^/]+)\/(.+)$/, // Windows
  /^\/__w\/([^/]+)\/([^/]+)\/(.+)$/, // job containers
  /^(?:[A-Za-z]:)?(?:\/[^/]+)*\/_work\/([^/]+)\/([^/]+)\/(.+)$/, // self-hosted runners
];

/**
 * Turns a GitHub Actions workspace path (<work>/<repo>/<repo>/<file>) into
 * <file> with forward slashes. Returns null for any other path.
 */
export function stripRunnerPrefix(raw: string): string | null {
  const p = toPosix(raw.trim());
  for (const re of RUNNER_WORKSPACES) {
    const m = re.exec(p);
    if (m?.[1] && m[2] && m[3] && m[1].toLowerCase() === m[2].toLowerCase()) return m[3];
  }
  return null;
}

/** A reported absolute path as a path relative to the repository root. */
export function toRepoPath(raw: string, root: string): { path: string } | { reason: 'outside-repo' | 'invalid-path' } {
  let rel = stripRunnerPrefix(raw);
  if (rel === null) {
    const p = raw.trim();
    if (path.isAbsolute(p)) {
      // Compare real paths: the report and git may spell the same folder differently
      // (Windows short names, links such as /var -> /private/var on macOS).
      const abs = realPathOf(p);
      const realRoot = realPathOf(root);
      if (!isInside(realRoot, abs)) return { reason: 'outside-repo' };
      rel = path.relative(realRoot, abs);
    } else if (path.win32.isAbsolute(p) || path.posix.isAbsolute(p)) {
      // Absolute on another operating system: the report came from a different machine.
      return { reason: 'outside-repo' };
    } else {
      return { reason: 'invalid-path' };
    }
  }
  const segments = toPosix(rel).split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return { reason: 'invalid-path' };
  return { path: segments.join('/') };
}

function unresolved(kind: ShotKind, reason: UnresolvedReason, candidates: string[] = []): Resolution {
  return { status: 'unresolved', kind, reason, candidates };
}

function lastSegment(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

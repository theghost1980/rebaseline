import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isInside, toPosix } from '../lib/paths.js';
import { listTrackedPngs, repoRoot } from './git.js';
import type { Failure, Report, Resolution, Shot, ShotKind, UnresolvedReason } from './types.js';

export interface Baselines {
  /** Absolute path of the repository root. */
  root: string;
  /** SHA-1 of the content -> paths relative to the root, with forward slashes. */
  index: Map<string, string[]>;
}

/** Reads the tracked PNG files under `cwd`. */
export async function loadBaselines(cwd: string): Promise<Baselines> {
  const root = await repoRoot(cwd);
  return { root, index: await hashFiles(root, await listTrackedPngs(cwd)) };
}

/** SHA-1 of each file (paths relative to root). Missing files are skipped. */
export async function hashFiles(root: string, files: string[], concurrency = 16): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
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
      const sha1 = createHash('sha1').update(data).digest('hex');
      const list = index.get(sha1);
      if (list) list.push(file);
      else index.set(sha1, [file]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  for (const list of index.values()) list.sort();
  return index;
}

/** Resolution of every shot in the report, by shot id. */
export function resolveReport(report: Report, baselines: Baselines): Map<string, Resolution> {
  const out = new Map<string, Resolution>();
  for (const failure of report.failures) {
    for (const shot of failure.shots) out.set(shot.id, resolveShot(failure, shot, baselines));
  }
  return out;
}

/** Decides which repository file an accepted screenshot replaces or creates. */
export function resolveShot(failure: Pick<Failure, 'projectName'>, shot: Shot, baselines: Baselines): Resolution {
  const kind: ShotKind = shot.missingPath !== null ? 'new' : 'changed';
  if (shot.actual.sha1 === null) return unresolved(kind, 'missing-image');

  if (shot.missingPath !== null) {
    const repoPath = toRepoPath(shot.missingPath, baselines.root);
    return 'path' in repoPath ? { status: 'resolved', kind, target: repoPath.path } : unresolved(kind, repoPath.reason);
  }

  if (!shot.expected?.sha1) return unresolved(kind, 'no-expected-image');
  const candidates = baselines.index.get(shot.expected.sha1) ?? [];
  const [only] = candidates;
  if (candidates.length === 0 || !only) return unresolved(kind, 'no-match');
  if (candidates.length === 1) return { status: 'resolved', kind, target: only };

  const narrowed = narrowCandidates(candidates, failure.projectName, shot.name);
  const [pick] = narrowed;
  if (narrowed.length === 1 && pick) return { status: 'resolved', kind, target: pick };
  return unresolved(kind, 'ambiguous', narrowed.length > 0 ? narrowed : candidates);
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
      const abs = path.resolve(p);
      if (!isInside(root, abs)) return { reason: 'outside-repo' };
      rel = path.relative(root, abs);
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

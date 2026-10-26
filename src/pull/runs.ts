import { UserError } from '../lib/errors.js';
import { ghJson } from './gh.js';
import { type RepoRef, parseRepoName, repoName } from './repo.js';

/** A workflow run, with the fields of "gh run list --json". */
export interface Run {
  databaseId: number;
  attempt: number;
  status: string;
  conclusion: string;
  headSha: string;
  headBranch: string;
  event: string;
  workflowName: string;
  displayTitle: string;
  createdAt: string;
  url: string;
}

const RUN_FIELDS = 'databaseId,attempt,status,conclusion,headSha,headBranch,event,workflowName,displayTitle,createdAt,url';

/** An artifact, with the fields of the GitHub REST API. */
export interface Artifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  created_at: string;
}

export interface PullRequest {
  number: number;
  headRefName: string;
  headRefOid: string;
  url: string;
}

/** A run or pull request chosen by number, or by URL (which also names the repository). */
export interface Reference {
  number: number;
  repo: RepoRef | null;
}

/** Runs only look at the newest ones; older reports are rarely what the user wants. */
const RUN_LIMIT = 20;
/** Finished runs checked for a report before giving up. */
const SEARCH_LIMIT = 10;

export const DEFAULT_ARTIFACT = 'playwright-report';

/** Parses a run number or a run URL (https://github.com/owner/name/actions/runs/123...). */
export function parseRunReference(value: string | number): Reference | null {
  return parseReference(value, /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:[/?#]|$)/i);
}

/** Parses a pull request number, "#12", or a pull request URL. */
export function parsePullRequestReference(value: string | number): Reference | null {
  return parseReference(value, /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#]|$)/i);
}

function parseReference(value: string | number, urlPattern: RegExp): Reference | null {
  const text = String(value).trim();
  const plain = /^#?(\d+)$/.exec(text);
  if (plain?.[1]) return toReference(plain[1], null);
  const m = urlPattern.exec(text);
  if (!m?.[1] || !m[4]) return null;
  const repo = parseRepoName(`${m[1]}/${m[2]}/${m[3]}`);
  return repo ? toReference(m[4], repo) : null;
}

function toReference(digits: string, repo: RepoRef | null): Reference | null {
  const number = Number(digits);
  return Number.isSafeInteger(number) && number > 0 ? { number, repo } : null;
}

function cannotSee(subject: string): UserError {
  return new UserError(
    `${subject} was not found, or the current GitHub account cannot see it`,
    'Check the account with "gh auth status". For a private repository you can also set GH_TOKEN to a token that can read its Actions.',
  );
}

/** Newest runs first, for a branch or for a commit. */
export function listRuns(repo: RepoRef, filter: { branch: string } | { commit: string }, cwd: string): Promise<Run[]> {
  const by = 'branch' in filter ? ['--branch', filter.branch] : ['--commit', filter.commit];
  return ghJson<Run[]>(['run', 'list', '-R', repoName(repo), ...by, '--limit', String(RUN_LIMIT), '--json', RUN_FIELDS], {
    cwd,
    notFound: () => cannotSee(repoName(repo)),
    what: `the Actions runs of ${repoName(repo)}`,
  });
}

export function viewRun(repo: RepoRef, id: number, cwd: string): Promise<Run> {
  return ghJson<Run>(['run', 'view', String(id), '-R', repoName(repo), '--json', RUN_FIELDS], {
    cwd,
    notFound: () => cannotSee(`Run ${id} of ${repoName(repo)}`),
    what: `the Actions runs of ${repoName(repo)}`,
  });
}

export function viewPullRequest(repo: RepoRef, number: number, cwd: string): Promise<PullRequest> {
  // Asking for more than "number" makes gh check that the pull request exists.
  return ghJson<PullRequest>(['pr', 'view', String(number), '-R', repoName(repo), '--json', 'number,headRefName,headRefOid,url'], {
    cwd,
    notFound: () => cannotSee(`Pull request #${number} of ${repoName(repo)}`),
    what: `the pull requests of ${repoName(repo)}`,
  });
}

export async function listArtifacts(repo: RepoRef, runId: number, cwd: string): Promise<Artifact[]> {
  const host = repo.host === 'github.com' ? [] : ['--hostname', repo.host];
  const artifacts: Artifact[] = [];
  for (let page = 1; ; page++) {
    const res = await ghJson<{ total_count?: number; artifacts?: Artifact[] }>(
      ['api', ...host, `repos/${repo.owner}/${repo.name}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`],
      { cwd, notFound: () => cannotSee(`Run ${runId} of ${repoName(repo)}`), what: `the artifacts of ${repoName(repo)}` },
    );
    const batch = res.artifacts ?? [];
    artifacts.push(...batch);
    if (batch.length === 0 || artifacts.length >= (res.total_count ?? 0)) return artifacts;
  }
}

export type ReportArtifacts =
  | { kind: 'html'; artifacts: Artifact[] }
  /** Sharded runs often upload blob reports, which need merging first. */
  | { kind: 'blob'; artifacts: Artifact[] }
  | { kind: 'none' };

/** Names that suggest a report, such as "playwright-report", "e2e-report" or "blob-report-1". */
const REPORT_LIKE = /report|playwright/i;
const BLOB_LIKE = /blob/i;

/**
 * The artifacts that hold the report. With a name (where * matches any text),
 * every artifact that matches; otherwise "playwright-report", or the
 * "playwright-report*" artifacts of a sharded run.
 */
export function selectReportArtifacts(all: Artifact[], name?: string): ReportArtifacts {
  const artifacts = newestByName(all);

  if (name !== undefined) {
    const pattern = new RegExp(`^${name.split('*').map(escapeRegExp).join('.*')}$`, 'i');
    const matched = artifacts.filter((a) => pattern.test(a.name));
    return matched.length > 0 ? { kind: 'html', artifacts: matched } : { kind: 'none' };
  }
  const exact = artifacts.filter((a) => a.name === DEFAULT_ARTIFACT);
  if (exact.length > 0) return { kind: 'html', artifacts: exact };
  const shards = artifacts.filter((a) => a.name.startsWith(DEFAULT_ARTIFACT));
  if (shards.length > 0) return { kind: 'html', artifacts: shards };
  // Only when no other artifact looks like a report, which could be an HTML report with its own name.
  const reports = artifacts.filter((a) => REPORT_LIKE.test(a.name));
  if (reports.length > 0 && reports.every((a) => BLOB_LIKE.test(a.name))) return { kind: 'blob', artifacts: reports };
  return { kind: 'none' };
}

/**
 * The artifacts in the order to look for the report in: names that look like
 * reports, then blob reports, then the rest, largest first in each group.
 */
export function rankArtifacts(all: Artifact[]): Artifact[] {
  const group = (a: Artifact) => (!REPORT_LIKE.test(a.name) ? 2 : BLOB_LIKE.test(a.name) ? 1 : 0);
  return newestByName(all).sort((a, b) => group(a) - group(b) || b.size_in_bytes - a.size_in_bytes);
}

/** A re-run can upload an artifact with the same name again; keeps the newest, sorted by name. */
function newestByName(all: Artifact[]): Artifact[] {
  const newest = new Map<string, Artifact>();
  for (const a of all) {
    const seen = newest.get(a.name);
    if (!seen || a.created_at > seen.created_at) newest.set(a.name, a);
  }
  return [...newest.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}

export interface RunWithReport {
  run: Run;
  artifacts: Artifact[];
  report: ReportArtifacts;
}

/**
 * The newest finished run (of `runs`, newest first) that uploaded a report.
 * Runs of other workflows, such as linting, have no report and are skipped.
 * Without a name, a report with its own name is not found; then the newest run
 * with artifacts that look like reports is returned (kind "none"), so the
 * caller can name them.
 */
export async function newestRunWithReport(repo: RepoRef, runs: Run[], name: string | undefined, cwd: string): Promise<RunWithReport | null> {
  let named: RunWithReport | null = null;
  for (const run of searchedRuns(runs)) {
    const artifacts = await listArtifacts(repo, run.databaseId, cwd);
    const report = selectReportArtifacts(artifacts, name);
    if (report.kind !== 'none') return { run, artifacts, report };
    if (!named && name === undefined && artifacts.some((a) => REPORT_LIKE.test(a.name))) named = { run, artifacts, report };
  }
  return named;
}

/** The runs newestRunWithReport() looks at: the newest finished ones. */
export function searchedRuns(runs: Run[]): Run[] {
  return runs.filter(isFinished).slice(0, SEARCH_LIMIT);
}

export function isFinished(run: Run): boolean {
  return run.status === 'completed';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

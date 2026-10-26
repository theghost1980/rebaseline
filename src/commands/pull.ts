import { rm } from 'node:fs/promises';
import { repoRoot } from '../core/git.js';
import { mergeReports, readReport } from '../core/report-reader.js';
import { UserError } from '../lib/errors.js';
import { formatBytes, plural, timeAgo } from '../lib/format.js';
import { color, log, withSpinner } from '../lib/output.js';
import { onStopSignal } from '../lib/signals.js';
import { downloadReports } from '../pull/download.js';
import { makeDownloadDir, removeStaleDownloads } from '../pull/download-dir.js';
import { currentBranch, findRepo, headCommit, type RepoRef, repoName, sameRepo } from '../pull/repo.js';
import {
  type Artifact,
  DEFAULT_ARTIFACT,
  isFinished,
  listArtifacts,
  listRuns,
  newestRunWithReport,
  parsePullRequestReference,
  parseRunReference,
  rankArtifacts,
  type Reference,
  type ReportArtifacts,
  type Run,
  searchedRuns,
  selectReportArtifacts,
  viewPullRequest,
  viewRun,
} from '../pull/runs.js';
import { MERGE_REPORTS_YAML, UPLOAD_REPORT_YAML } from '../pull/snippets.js';
import { parsePort, reviewReport } from '../review/review-report.js';

export interface PullOptions {
  run?: string | number;
  pr?: string | number;
  // The option parser turns numeric values into numbers.
  artifact?: string | number;
  repo?: string | number;
  port?: number | string;
  open?: boolean;
}

interface Choice {
  run: Run;
  artifacts: Artifact[];
  report: ReportArtifacts;
  /** Chosen with --run, so it is reviewed even if it passed. */
  explicit: boolean;
  /** A newer run of the same workflow that has not finished. */
  newer: Run | null;
}

/** Artifacts named in the message when the report is not found. */
const LISTED_ARTIFACTS = 8;

const CONCLUSIONS: Record<string, string> = { success: 'passed', failure: 'failed', timed_out: 'timed out', startup_failure: 'failed to start' };

export async function pull(options: PullOptions): Promise<void> {
  const cwd = process.cwd();
  const port = parsePort(options.port);
  if (options.run !== undefined && options.pr !== undefined) {
    throw new UserError('Use --run or --pr, not both', 'Leave both out to use the newest run of the current branch.');
  }
  const runRef = options.run === undefined ? null : reference(parseRunReference(options.run), '--run', options.run, 'a run number or URL');
  const prRef = options.pr === undefined ? null : reference(parsePullRequestReference(options.pr), '--pr', options.pr, 'a pull request number or URL');
  const artifactName = options.artifact === undefined ? undefined : String(options.artifact);
  await repoRoot(cwd); // Fails early, with a clear message, outside a git repository.
  const repo = await chooseRepo(cwd, options.repo === undefined ? undefined : String(options.repo), (runRef ?? prRef)?.repo ?? null);

  let choice: Choice;
  if (runRef) {
    choice = await chooseGivenRun(repo, runRef.number, artifactName, cwd);
  } else if (prRef) {
    const pr = await viewPullRequest(repo, prRef.number, cwd);
    const runs = await listRuns(repo, { commit: pr.headRefOid }, cwd);
    // The repository is named because it comes from the current folder, which may not be the intended one.
    choice = await chooseNewestRun(repo, runs, `pull request #${pr.number} of ${repoName(repo)}`, artifactName, cwd);
  } else {
    const branch = await currentBranch(cwd);
    const runs = await listRuns(repo, { branch }, cwd);
    choice = await chooseNewestRun(repo, runs, `branch ${branch} of ${repoName(repo)}`, artifactName, cwd);
  }

  const { run } = choice;
  describeRun(run);
  if (choice.newer) {
    log.warn(`A newer run of "${run.workflowName}" has not finished yet.`, `Run the command again when it is done: ${choice.newer.url}`);
  }
  if (!choice.explicit && run.conclusion === 'success') {
    log.success('The run passed. Nothing to review.');
    return;
  }
  const head = await headCommit(cwd);
  if (head && run.headSha && head !== run.headSha) {
    log.warn(
      `The run tested commit ${run.headSha.slice(0, 7)}, but your checkout is at ${head.slice(0, 7)}.`,
      'Accepted screenshots are written to your checkout, so make sure it has the baselines the run compared against.',
    );
  }

  const artifacts = reportArtifacts(run, choice.artifacts, choice.report, artifactName);
  const size = formatBytes(artifacts.reduce((n, a) => n + a.size_in_bytes, 0));
  const label = artifacts.length === 1 ? (artifacts[0]?.name ?? '') : plural(artifacts.length, 'report artifact');

  await removeStaleDownloads();
  const tmp = await makeDownloadDir();
  try {
    const dirs = await withSpinner(`Downloading ${label} (${size})`, () =>
      untilInterrupted((signal) => downloadReports(repo, run, artifacts, tmp, cwd, signal)),
    );
    log.success(`Downloaded ${label} (${size}).`);
    const report = mergeReports(await Promise.all(dirs.map((dir) => readReport(dir))), tmp);
    await reviewReport(report, { cwd, source: `run ${run.databaseId}`, port, open: options.open !== false, exclude: [tmp] });
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  }
}

function reference(ref: Reference | null, option: string, value: string | number, expected: string): Reference {
  if (!ref) throw new UserError(`Invalid ${option}: ${String(value)}`, `Use ${expected}.`);
  return ref;
}

/** The repository of a --run or --pr URL wins; the git remote is only used to warn about a mismatch. */
async function chooseRepo(cwd: string, explicit: string | undefined, fromUrl: RepoRef | null): Promise<RepoRef> {
  if (!fromUrl || explicit !== undefined) return findRepo(cwd, explicit);
  const local = await findRepo(cwd).catch(() => null);
  if (local && !sameRepo(local, fromUrl)) {
    log.warn(
      `The link points to ${repoName(fromUrl)}, but this folder belongs to ${repoName(local)}.`,
      'Accepted screenshots are written to this folder; run rebaseline from a checkout of the linked repository.',
    );
  }
  return fromUrl;
}

async function chooseGivenRun(repo: RepoRef, id: number, name: string | undefined, cwd: string): Promise<Choice> {
  const run = await viewRun(repo, id, cwd);
  if (!isFinished(run)) throw new UserError(`Run ${id} has not finished yet`, `Wait for it to finish, then run the command again: ${run.url}`);
  const artifacts = await listArtifacts(repo, id, cwd);
  return { run, artifacts, report: selectReportArtifacts(artifacts, name), explicit: true, newer: null };
}

async function chooseNewestRun(repo: RepoRef, runs: Run[], subject: string, name: string | undefined, cwd: string): Promise<Choice> {
  const [latest] = runs;
  if (!latest) {
    throw new UserError(`No workflow runs found for ${subject}`, 'Push your changes and wait for CI to start, or choose a run with --run <id|url>.');
  }
  const found = await newestRunWithReport(repo, runs, name, cwd);
  if (!found) {
    if (!runs.some(isFinished)) {
      throw new UserError(`No workflow run for ${subject} has finished yet`, `Wait for it to finish, then run the command again: ${latest.url}`);
    }
    // Naming the runs shows whether the workflow, the artifact name or the branch is the problem.
    const searched = searchedRuns(runs);
    const checked = `Checked ${plural(searched.length, 'finished run')} (${[...new Set(searched.map((r) => r.workflowName))].join(', ')}).`;
    if (name !== undefined) {
      throw new UserError(`No recent run for ${subject} has an artifact named ${name}`, `${checked} Check the name, or choose a run with --run <id|url>.`);
    }
    throw new UserError(
      `No recent run for ${subject} uploaded a Playwright report`,
      `${checked} Upload the HTML report as an artifact in your workflow, for example:`,
      UPLOAD_REPORT_YAML,
    );
  }
  const newer = runs.find((r) => !isFinished(r) && r.workflowName === found.run.workflowName && r.createdAt > found.run.createdAt) ?? null;
  return { ...found, explicit: false, newer };
}

/** The report artifacts to download, or an error that says what is missing. */
function reportArtifacts(run: Run, all: Artifact[], report: ReportArtifacts, name: string | undefined): Artifact[] {
  const id = run.databaseId;
  if (report.kind === 'blob') {
    throw new UserError(
      `Run ${id} uploaded blob reports, not an HTML report`,
      'Merge them into an HTML report in your workflow and upload it as an artifact, for example:',
      MERGE_REPORTS_YAML,
    );
  }
  if (report.kind === 'none') {
    if (all.length === 0) {
      throw new UserError(`Run ${id} has no artifacts`, 'Upload the HTML report as an artifact in your workflow, for example:', UPLOAD_REPORT_YAML);
    }
    // The likeliest report first: an HTML report is usually the largest artifact that looks like one.
    const ranked = rankArtifacts(all);
    const shown = ranked.slice(0, LISTED_ARTIFACTS).map((a) => `${a.name} (${formatBytes(a.size_in_bytes)})`);
    const more = ranked.length > LISTED_ARTIFACTS ? `, and ${ranked.length - LISTED_ARTIFACTS} more` : '';
    throw new UserError(`Run ${id} has no artifact named ${name ?? DEFAULT_ARTIFACT}`, `Its artifacts: ${shown.join(', ')}${more}. Choose the report with --artifact <name>.`);
  }
  if (report.artifacts.some((a) => a.expired)) {
    throw new UserError(`The report of run ${id} has expired`, `GitHub deletes artifacts after their retention period. Re-run the workflow to get a new one: ${run.url}`);
  }
  return report.artifacts;
}

function describeRun(run: Run): void {
  const state = isFinished(run) ? (CONCLUSIONS[run.conclusion] ?? run.conclusion ?? 'finished') : run.status;
  const attempt = run.attempt > 1 ? `, attempt ${run.attempt}` : '';
  log.step(`Run ${run.databaseId}: "${run.workflowName}" on ${run.headBranch} (${state}${attempt}, ${timeAgo(run.createdAt)})`);
  log.plain(`  ${color.dim(run.url)}`);
}

/** Runs `task` and aborts it on Ctrl+C (or kill, or closed terminal), so the temporary files can be removed before exiting. */
async function untilInterrupted<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const stop = onStopSignal(() => controller.abort());
  try {
    return await task(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) throw new UserError('Download interrupted', 'Nothing was changed. Run the command again to review the run.');
    throw err;
  } finally {
    stop();
  }
}

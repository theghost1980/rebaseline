import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { UserError } from '../lib/errors.js';
import { runGh } from './gh.js';
import { type RepoRef, repoName } from './repo.js';
import type { Artifact, Run } from './runs.js';
import { MERGE_REPORTS_YAML, UPLOAD_REPORT_YAML } from './snippets.js';

/** How deep inside an artifact the report folder can be (path: test-output/playwright-report/). */
const MAX_DEPTH = 3;
/** Every Playwright HTML report embeds its data with this marker near the end of index.html. */
const REPORT_MARKER = 'data:application/zip;base64,';

/**
 * Downloads each artifact of `run` into its own folder under `dir` and
 * returns the report folders found in them.
 */
export async function downloadReports(
  repo: RepoRef,
  run: Run,
  artifacts: Artifact[],
  dir: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const reports: string[] = [];
  for (const [i, artifact] of artifacts.entries()) {
    const dest = path.join(dir, String(i + 1));
    await runGh(['run', 'download', String(run.databaseId), '-R', repoName(repo), '-n', artifact.name, '-D', dest], {
      cwd,
      signal,
      what: `the artifacts of ${repoName(repo)}`,
      notFound: () =>
        new UserError(`The artifact ${artifact.name} of run ${run.databaseId} could not be downloaded`, `It may have expired. Re-run the workflow to get a new one: ${run.url}`),
    });
    const report = await findReportDir(dest);
    if (report) {
      reports.push(report);
      continue;
    }
    const files = (await readdir(dest, { recursive: true }).catch(() => [])).map((name) => path.basename(String(name)));
    if (files.some(isBlobReport)) {
      throw new UserError(
        `The artifact ${artifact.name} holds blob reports, not an HTML report`,
        'Merge them into an HTML report in your workflow and upload it as an artifact, for example:',
        MERGE_REPORTS_YAML,
      );
    }
    if (files.some(isTestResult)) {
      throw new UserError(
        `The artifact ${artifact.name} holds test results, not the HTML report`,
        'Upload the playwright-report folder as an artifact in your workflow, for example:',
        UPLOAD_REPORT_YAML,
      );
    }
    throw new UserError(`The artifact ${artifact.name} does not contain a Playwright HTML report`, 'Choose the artifact that holds the report with --artifact <name>.');
  }
  return reports;
}

/** The folder under `dir` (or `dir` itself) that holds a Playwright HTML report. */
export async function findReportDir(dir: string, depth = 0): Promise<string | null> {
  if (await isReportPage(path.join(dir, 'index.html'))) return dir;
  if (depth >= MAX_DEPTH) return null;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const folders = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const name of folders) {
    const found = await findReportDir(path.join(dir, name), depth + 1);
    if (found) return found;
  }
  return null;
}

async function isReportPage(file: string): Promise<boolean> {
  try {
    return (await readFile(file, 'utf8')).includes(REPORT_MARKER);
  } catch {
    return false;
  }
}

/** The blob reporter writes report.zip, or report-<shard or project>.zip. */
function isBlobReport(file: string): boolean {
  return /^report.*\.zip$/i.test(file);
}

/** Files Playwright leaves in test-results/; trace.zip is one, which is not a blob report. */
function isTestResult(file: string): boolean {
  return file === 'trace.zip' || file === 'error-context.md' || file === '.last-run.json' || /^test-(failed|finished)-\d+\.png$/.test(file);
}

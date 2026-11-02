import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { findReportDir } from '../core/report-reader.js';
import { UserError } from '../lib/errors.js';
import { runGh } from './gh.js';
import { type RepoRef, repoName } from './repo.js';
import type { Artifact, Run } from './runs.js';
import { MERGE_REPORTS_YAML, UPLOAD_REPORT_YAML } from './snippets.js';

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
    const files = (await readdir(dest, { recursive: true }).catch(() => [])).map(String);
    throw noReportError(`The artifact ${artifact.name}`, files, 'Choose the artifact that holds the report with --artifact <name>.');
  }
  return reports;
}

/**
 * The error for a download without an HTML report, from the paths of its
 * files: blob reports and test results each get their own advice.
 */
export function noReportError(subject: string, files: string[], hint: string): UserError {
  const names = files.map((f) => path.basename(f));
  if (names.some(isBlobReport)) {
    return new UserError(
      `${subject} holds blob reports, not an HTML report`,
      'Merge them into an HTML report in your workflow and upload it as an artifact, for example:',
      MERGE_REPORTS_YAML,
    );
  }
  if (names.some(isTestResult)) {
    return new UserError(
      `${subject} holds test results, not the HTML report`,
      'Upload the playwright-report folder as an artifact in your workflow, for example:',
      UPLOAD_REPORT_YAML,
    );
  }
  return new UserError(`${subject} does not contain a Playwright HTML report`, hint);
}

/** The blob reporter writes report.zip, or report-<shard or project>.zip. */
function isBlobReport(file: string): boolean {
  return /^report.*\.zip$/i.test(file);
}

/** Files Playwright leaves in test-results/; trace.zip is one, which is not a blob report. */
function isTestResult(file: string): boolean {
  return file === 'trace.zip' || file === 'error-context.md' || file === '.last-run.json' || /^test-(failed|finished)-\d+\.png$/.test(file);
}

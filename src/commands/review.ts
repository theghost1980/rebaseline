import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { findReportDir, ReportError, readReport } from '../core/report-reader.js';
import type { Report } from '../core/types.js';
import { UserError } from '../lib/errors.js';
import { log, withSpinner } from '../lib/output.js';
import { displayPath } from '../lib/paths.js';
import { noReportError } from '../pull/download.js';
import { makeDownloadDir, removeStaleDownloads } from '../pull/download-dir.js';
import { extractReport } from '../review/report-zip.js';
import { parsePort, reviewReport } from '../review/review-report.js';
import { playwrightArgs, runPlaywright } from '../review/run-playwright.js';

export interface ReviewOptions {
  // The option parser turns numeric values into numbers.
  report?: string | number;
  run?: boolean;
  port?: number | string;
  open?: boolean;
  /** Arguments after "--", passed to Playwright with --run. */
  '--'?: string[];
}

export async function review(options: ReviewOptions): Promise<void> {
  const cwd = process.cwd();
  const reportPath = path.resolve(String(options.report ?? 'playwright-report'));
  const port = parsePort(options.port);
  const open = options.open !== false;
  const isFile = await stat(reportPath).then(
    (s) => s.isFile(),
    () => false,
  );

  if (options.run) {
    if (isFile) throw new UserError('--run writes the report to a folder, not to a file', 'Point --report at a folder, or leave it out.');
    const extra = options['--'] ?? [];
    log.step(`Running Playwright: playwright ${playwrightArgs(extra).join(' ')}`);
    await runPlaywright(cwd, reportPath, extra);
    log.plain();
  } else if ((options['--'] ?? []).length > 0) {
    throw new UserError('Arguments after "--" are only used with --run', 'Add --run, or remove the arguments after "--".');
  }

  if (isFile) {
    await reviewZip(reportPath, cwd, port, open);
    return;
  }
  // An extracted artifact can hold the report one folder down.
  const reportDir = options.run ? reportPath : ((await findReportDir(reportPath)) ?? reportPath);
  const report = await loadReport(reportDir, Boolean(options.run));
  await reviewReport(report, {
    cwd,
    source: displayPath(reportDir),
    port,
    open,
    exclude: [reportDir],
    reportDir,
  });
}

/** Reviews the report in a zip, such as an artifact downloaded from a workflow run page, from a temporary folder. */
async function reviewZip(file: string, cwd: string, port: number, open: boolean): Promise<void> {
  const shown = displayPath(file);
  await removeStaleDownloads();
  const tmp = await makeDownloadDir();
  try {
    const files = await withSpinner(`Extracting ${shown}`, () => extractReport(file, tmp));
    const reportDir = await findReportDir(tmp);
    if (!reportDir) throw noReportError(shown, files, 'Download the artifact that holds the HTML report, usually playwright-report.');
    const report = await readReport(reportDir);
    await reviewReport(report, { cwd, source: shown, port, open, exclude: [tmp] });
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function loadReport(reportDir: string, afterRun: boolean): Promise<Report> {
  try {
    return await readReport(reportDir);
  } catch (err) {
    if (err instanceof ReportError && err.code === 'not-found') {
      throw new UserError(
        err.message,
        afterRun
          ? 'Playwright did not write an HTML report. Check its output above.'
          : 'Run your tests with the HTML reporter first (npx playwright test --reporter=html), use --run, or point --report at the report folder or at the zip of a report artifact.',
      );
    }
    throw err;
  }
}

import path from 'node:path';
import html from 'virtual:ui-html';
import { ReportError, readReport } from '../core/report-reader.js';
import { loadBaselines, resolveReport } from '../core/resolver.js';
import type { Report } from '../core/types.js';
import { UserError } from '../lib/errors.js';
import { openBrowser } from '../lib/open-browser.js';
import { askYesNo, bullet, canAsk, color, log, withSpinner } from '../lib/output.js';
import { displayPath } from '../lib/paths.js';
import { offerCleanup } from '../review/cleanup.js';
import { playwrightArgs, runPlaywright } from '../review/run-playwright.js';
import { ReviewSession, unsavedSnapshots } from '../review/session.js';
import { printSummary } from '../review/summary.js';
import { startServer } from '../server/server.js';

export interface ReviewOptions {
  report?: string;
  run?: boolean;
  port?: number | string;
  open?: boolean;
  /** Arguments after "--", passed to Playwright with --run. */
  '--'?: string[];
}

export async function review(options: ReviewOptions): Promise<void> {
  const cwd = process.cwd();
  const reportDir = path.resolve(options.report ?? 'playwright-report');
  const port = parsePort(options.port);

  if (options.run) {
    const extra = options['--'] ?? [];
    log.step(`Running Playwright: playwright ${playwrightArgs(extra).join(' ')}`);
    await runPlaywright(cwd, reportDir, extra);
    log.plain();
  } else if ((options['--'] ?? []).length > 0) {
    throw new UserError('Arguments after "--" are only used with --run', 'Add --run, or remove the arguments after "--".');
  }

  const report = await loadReport(reportDir, Boolean(options.run));
  const shots = report.failures.reduce((n, f) => n + f.shots.length, 0);
  const others = report.failures.filter((f) => f.shots.length === 0);
  const unsaved = report.failures.flatMap(unsavedSnapshots);

  if (report.failures.length === 0) {
    log.success(`No failed tests in ${displayPath(reportDir)}. Nothing to review.`);
    return;
  }
  if (shots === 0) {
    log.warn(`${plural(others.length, 'test')} failed in ${displayPath(reportDir)}, none of them on a screenshot.`);
    for (const f of others.slice(0, 10)) log.plain(`  ${bullet} [${f.projectName}] ${f.titlePath.join(' > ')} (${f.file}:${f.line})`);
    if (others.length > 10) log.plain(`  ${bullet} ...and ${others.length - 10} more`);
    warnUnsaved(unsaved);
    return;
  }

  const baselines = await withSpinner('Reading baselines', () => loadBaselines(cwd, { exclude: [reportDir] }));
  const resolutions = resolveReport(report, baselines);
  const unresolved = [...resolutions.values()].filter((r) => r.status === 'unresolved').length;
  const session = new ReviewSession(report, resolutions, baselines.root);
  const server = await startServer(session, { html, port });

  log.step(
    `${plural(shots, 'failed screenshot')} to review` +
      (others.length > 0 ? `, plus ${plural(others.length, 'other failure')}` : '') +
      '.',
  );
  if (unresolved > 0) log.warn(`${plural(unresolved, 'screenshot')} cannot be accepted; the page explains why.`);
  warnUnsaved(unsaved);
  log.plain(`  Review page: ${server.url}`);
  log.plain(`  ${color.dim('Click Done on the page, or press Ctrl+C here, when you are finished.')}`);

  if (options.open !== false && !(await openBrowser(server.url))) {
    log.warn('Could not open the browser.', 'Open the address above in your browser.');
  }

  const reason = await Promise.race([server.finished.then(() => 'done' as const), interrupted().then(() => 'interrupted' as const)]);
  await session.idle();
  await server.close();
  const results = session.results();
  await printSummary(results, baselines.root);
  // Deleting is only offered after Done, when someone can answer here.
  await offerCleanup(baselines.root, results.rejectedNew, reason === 'done' && canAsk ? askYesNo : undefined);
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
          : 'Run your tests with the HTML reporter first (npx playwright test --reporter=html), use --run, or point --report at the report folder.',
      );
    }
    throw err;
  }
}

function warnUnsaved(unsaved: string[]): void {
  if (unsaved.length === 0) return;
  log.warn(
    `${plural(unsaved.length, 'new screenshot')} reported by Playwright ${unsaved.length === 1 ? 'was' : 'were'} not saved, so ${unsaved.length === 1 ? 'it' : 'they'} cannot be reviewed.`,
    'Run the tests without --update-snapshots=none (or updateSnapshots: "none") to review new screenshots.',
  );
}

function parsePort(value: number | string | undefined): number {
  if (value === undefined) return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UserError(`Invalid --port: ${String(value)}`, 'Use a number between 1 and 65535, or leave --port out.');
  }
  return port;
}

/** Resolves on the first Ctrl+C; a second one ends the process as usual. */
function interrupted(): Promise<void> {
  return new Promise((resolve) => {
    const onSignal = () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      resolve();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

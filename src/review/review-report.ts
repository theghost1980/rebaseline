import html from 'virtual:ui-html';
import { loadBaselines, resolveReport } from '../core/resolver.js';
import type { Report } from '../core/types.js';
import { UserError } from '../lib/errors.js';
import { plural } from '../lib/format.js';
import { openBrowser } from '../lib/open-browser.js';
import { askYesNo, bullet, canAsk, color, log, withSpinner } from '../lib/output.js';
import { startServer } from '../server/server.js';
import { offerCleanup } from './cleanup.js';
import { ReviewSession, unsavedSnapshots } from './session.js';
import { printSummary } from './summary.js';

export interface ReviewReportOptions {
  cwd: string;
  /** Where the report came from, for messages: a folder or a workflow run. */
  source: string;
  /** 0 picks any free port. */
  port: number;
  open: boolean;
  /** Folders that never hold baselines, such as the report folder. */
  exclude: string[];
}

/**
 * Serves the review page for `report` until the user clicks Done or presses
 * Ctrl+C, then prints the summary.
 */
export async function reviewReport(report: Report, options: ReviewReportOptions): Promise<void> {
  const shots = report.failures.reduce((n, f) => n + f.shots.length, 0);
  const others = report.failures.filter((f) => f.shots.length === 0);
  const unsaved = report.failures.flatMap(unsavedSnapshots);

  if (report.failures.length === 0) {
    log.success(`No failed tests in ${options.source}. Nothing to review.`);
    return;
  }
  if (shots === 0) {
    log.warn(`${plural(others.length, 'test')} failed in ${options.source}, none of them on a screenshot.`);
    for (const f of others.slice(0, 10)) log.plain(`  ${bullet} [${f.projectName}] ${f.titlePath.join(' > ')} (${f.file}:${f.line})`);
    if (others.length > 10) log.plain(`  ${bullet} ...and ${others.length - 10} more`);
    warnUnsaved(unsaved);
    return;
  }

  const baselines = await withSpinner('Reading baselines', () => loadBaselines(options.cwd, { exclude: options.exclude }));
  const resolutions = resolveReport(report, baselines);
  const unresolved = [...resolutions.values()].filter((r) => r.status === 'unresolved').length;
  const session = new ReviewSession(report, resolutions, baselines.root);
  const server = await startServer(session, { html, port: options.port });

  log.step(
    `${plural(shots, 'failed screenshot')} to review` +
      (others.length > 0 ? `, plus ${plural(others.length, 'other failure')}` : '') +
      '.',
  );
  if (unresolved > 0) log.warn(`${plural(unresolved, 'screenshot')} cannot be accepted; the page explains why.`);
  warnUnsaved(unsaved);
  log.plain(`  Review page: ${server.url}`);
  log.plain(`  ${color.dim('Click Done on the page, or press Ctrl+C here, when you are finished.')}`);

  if (options.open && !(await openBrowser(server.url))) {
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

function warnUnsaved(unsaved: string[]): void {
  if (unsaved.length === 0) return;
  log.warn(
    `${plural(unsaved.length, 'new screenshot')} reported by Playwright ${unsaved.length === 1 ? 'was' : 'were'} not saved, so ${unsaved.length === 1 ? 'it' : 'they'} cannot be reviewed.`,
    'Run the tests without --update-snapshots=none (or updateSnapshots: "none") to review new screenshots.',
  );
}

export function parsePort(value: number | string | undefined): number {
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

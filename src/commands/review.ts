import path from 'node:path';
import html from 'virtual:ui-html';
import { ReportError, readReport } from '../core/report-reader.js';
import { loadBaselines, resolveReport } from '../core/resolver.js';
import type { Report } from '../core/types.js';
import { UserError } from '../lib/errors.js';
import { openBrowser } from '../lib/open-browser.js';
import { bullet, color, log } from '../lib/output.js';
import { displayPath } from '../lib/paths.js';
import { ReviewSession } from '../review/session.js';
import { printSummary } from '../review/summary.js';
import { startServer } from '../server/server.js';

export interface ReviewOptions {
  report?: string;
  port?: number | string;
  open?: boolean;
}

export async function review(options: ReviewOptions): Promise<void> {
  const reportDir = path.resolve(options.report ?? 'playwright-report');
  const port = parsePort(options.port);
  const report = await loadReport(reportDir);

  const shots = report.failures.reduce((n, f) => n + f.shots.length, 0);
  const others = report.failures.filter((f) => f.shots.length === 0);
  if (report.failures.length === 0) {
    log.success(`No failed tests in ${displayPath(reportDir)}. Nothing to review.`);
    return;
  }
  if (shots === 0) {
    log.warn(`${plural(others.length, 'test')} failed in ${displayPath(reportDir)}, none of them on a screenshot.`);
    for (const f of others.slice(0, 10)) log.plain(`  ${bullet} [${f.projectName}] ${f.titlePath.join(' > ')} (${f.file}:${f.line})`);
    if (others.length > 10) log.plain(`  ${bullet} ...and ${others.length - 10} more`);
    return;
  }

  const baselines = await loadBaselines(process.cwd(), { exclude: [reportDir] });
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
  log.plain(`  Review page: ${server.url}`);
  log.plain(`  ${color.dim('Click Done on the page, or press Ctrl+C here, when you are finished.')}`);

  if (options.open !== false && !(await openBrowser(server.url))) {
    log.warn('Could not open the browser.', 'Open the address above in your browser.');
  }

  await Promise.race([server.finished, interrupted()]);
  await session.idle();
  await server.close();
  await printSummary(session.results(), baselines.root);
}

async function loadReport(reportDir: string): Promise<Report> {
  try {
    return await readReport(reportDir);
  } catch (err) {
    if (err instanceof ReportError && err.code === 'not-found') {
      throw new UserError(
        err.message,
        'Run your tests with the HTML reporter first (npx playwright test --reporter=html), or point --report at the report folder.',
      );
    }
    throw err;
  }
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

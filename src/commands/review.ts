import path from 'node:path';
import { ReportError, readReport } from '../core/report-reader.js';
import type { Report } from '../core/types.js';
import { UserError } from '../lib/errors.js';
import { log } from '../lib/output.js';
import { displayPath } from '../lib/paths.js';
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
  const reportDir = path.resolve(String(options.report ?? 'playwright-report'));
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
  await reviewReport(report, {
    cwd,
    source: displayPath(reportDir),
    port,
    open: options.open !== false,
    exclude: [reportDir],
    reportDir,
  });
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

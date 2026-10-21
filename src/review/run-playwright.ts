import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { UserError } from '../lib/errors.js';

export interface RunResult {
  /** Exit code of the test run: 0 when every test passed, 1 when some failed. */
  code: number;
}

/**
 * Finds the Playwright test runner installed in the project, looking up from
 * `cwd` like Node does (so hoisted monorepo installs work too).
 */
export function findPlaywrightCli(cwd: string): string {
  const require = createRequire(path.join(cwd, 'noop.js'));
  try {
    return require.resolve('@playwright/test/cli');
  } catch {
    throw new UserError(
      `@playwright/test is not installed in ${cwd}`,
      'Run rebaseline from your Playwright project folder, or run the tests yourself and then use rebaseline review.',
    );
  }
}

/** Arguments passed to Playwright: the user's own config, plus the HTML reporter. */
export function playwrightArgs(extra: string[]): string[] {
  return ['test', '--reporter=html,list', ...extra];
}

/** Environment that sends the HTML report to `reportDir` and keeps Playwright from opening it. */
export function playwrightEnv(reportDir: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    PLAYWRIGHT_HTML_OUTPUT_DIR: reportDir,
    PLAYWRIGHT_HTML_REPORT: reportDir,
    PLAYWRIGHT_HTML_OPEN: 'never',
    PW_TEST_HTML_REPORT_OPEN: 'never',
  };
}

/**
 * Runs the project's Playwright tests with the HTML reporter, showing their
 * output. The project's config is not changed.
 */
export function runPlaywright(cwd: string, reportDir: string, extra: string[]): Promise<RunResult> {
  const cli = findPlaywrightCli(cwd);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...playwrightArgs(extra)], {
      cwd,
      env: playwrightEnv(reportDir),
      stdio: 'inherit',
    });
    child.once('error', (err) => reject(new UserError(`Could not start Playwright: ${err.message}`)));
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new UserError('The test run was interrupted', 'Run the command again to review the results.'));
      } else if (code === 0 || code === 1) {
        resolve({ code });
      } else {
        reject(new UserError(`Playwright stopped with exit code ${code}`, 'Check its output above, fix the problem and run again.'));
      }
    });
  });
}

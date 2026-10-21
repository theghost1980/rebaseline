import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findPlaywrightCli, playwrightArgs, playwrightEnv } from '../src/review/run-playwright.js';
import { installFakePlaywright, tempDir } from './helpers.js';

describe('running Playwright', () => {
  it('keeps the user config and adds the HTML reporter', () => {
    expect(playwrightArgs([])).toEqual(['test', '--reporter=html,list']);
    expect(playwrightArgs(['--project=chromium', 'home.spec.ts'])).toEqual(['test', '--reporter=html,list', '--project=chromium', 'home.spec.ts']);
  });

  it('sends the report to the chosen folder and never opens it', () => {
    const env = playwrightEnv('/work/report', { PATH: 'x', PLAYWRIGHT_HTML_OPEN: 'always' });
    expect(env).toMatchObject({
      PATH: 'x',
      PLAYWRIGHT_HTML_OUTPUT_DIR: '/work/report',
      PLAYWRIGHT_HTML_REPORT: '/work/report',
      PLAYWRIGHT_HTML_OPEN: 'never',
      PW_TEST_HTML_REPORT_OPEN: 'never',
    });
  });

  it('finds the Playwright installed in the project, also from a subfolder', () => {
    const project = tempDir();
    installFakePlaywright(project, '');
    const expected = path.join(project, 'node_modules', '@playwright', 'test', 'cli.js');
    expect(findPlaywrightCli(project)).toBe(expected);
    expect(findPlaywrightCli(path.join(project, 'packages', 'e2e'))).toBe(expected);
  });

  it('explains when Playwright is not installed', () => {
    expect(() => findPlaywrightCli(tempDir())).toThrow(/@playwright\/test is not installed/);
  });
});

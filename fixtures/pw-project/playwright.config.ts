import { defineConfig } from '@playwright/test';

// Minimal project used to produce real Playwright HTML reports for rebaseline's tests.
// Both projects render the same pages, so their screenshots are byte-identical:
// that is the tie the resolver has to break with the project name.
export default defineConfig({
  testDir: './tests',
  // Without these, Playwright puts both folders next to the nearest package.json (the repo root).
  outputDir: './test-results',
  fullyParallel: true,
  reporter: [['html', { open: 'never', outputFolder: './playwright-report' }], ['list']],
  use: {
    browserName: 'chromium',
    viewport: { width: 320, height: 200 },
    deviceScaleFactor: 1,
  },
  projects: [
    { name: 'default' },
    {
      name: 'custom',
      snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}',
    },
  ],
});

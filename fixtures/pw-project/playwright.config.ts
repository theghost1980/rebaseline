import { defineConfig } from '@playwright/test';

// Minimal Playwright project used to generate test data.
// Both projects render the same pages on purpose.
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

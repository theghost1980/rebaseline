// Workflow steps shown in error messages, ready to paste into a GitHub Actions workflow.

export const UPLOAD_REPORT_YAML = `      - uses: actions/upload-artifact@v7
        if: \${{ !cancelled() }}
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 30
`;

export const MERGE_REPORTS_YAML = `  merge-reports:
    if: \${{ !cancelled() }}
    needs: [test] # your test job
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
      - run: npm ci
      - uses: actions/download-artifact@v8
        with:
          path: all-blob-reports
          pattern: blob-report-*
          merge-multiple: true
      - run: npx playwright merge-reports --reporter html ./all-blob-reports
      - uses: actions/upload-artifact@v7
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 30
`;

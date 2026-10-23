import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReportError, readReport, reportPlatform } from '../src/core/report-reader.js';
import type { Failure, Report } from '../src/core/types.js';
import { fixtureDir, png, sha1, tempDir, writeFiles, writeReport } from './helpers.js';

const CI_PROJECT = '/home/runner/work/rebaseline/rebaseline/fixtures/pw-project';

function find(report: Report, projectName: string, title: string): Failure {
  const failure = report.failures.find((f) => f.projectName === projectName && f.title === title);
  if (!failure) throw new Error(`no failure "${title}" in project ${projectName}`);
  return failure;
}

describe('readReport with the saved Playwright 1.64.1 report', async () => {
  const report = await readReport(path.join(fixtureDir, 'report'));

  it('lists only the tests that did not pass, project by project', () => {
    expect(report.projectNames).toEqual(['default', 'custom']);
    expect(report.failures).toHaveLength(10);
    expect(report.failures.map((f) => f.projectName)).toEqual([...Array(5).fill('default'), ...Array(5).fill('custom')]);
    expect(report.failures.some((f) => f.title === 'unchanged screenshot')).toBe(false);
  });

  it('reads a changed screenshot from the last result', () => {
    for (const project of ['default', 'custom']) {
      const failure = find(report, project, 'changed screenshot');
      expect(failure.retries).toBe(1);
      expect(failure.status).toBe('failed');
      expect(failure.file).toBe('visual.spec.ts');
      expect(failure.line).toBe(15);
      expect(failure.stoppedAtScreenshot).toBe(true);
      expect(failure.shots).toHaveLength(1);
      const [shot] = failure.shots;
      expect(shot?.name).toBe('hero');
      expect(shot?.missingPath).toBeNull();
      expect(shot?.actual.sha1).toMatch(/^[0-9a-f]{40}$/);
      expect(shot?.diff?.sha1).toMatch(/^[0-9a-f]{40}$/);
      expect(shot?.expected?.sha1).not.toBe(shot?.actual.sha1);
    }
  });

  it('reads the expected image of a changed screenshot', () => {
    const baseline = readFileSync(path.join(fixtureDir, 'baselines/tests/visual.spec.ts-snapshots/hero-default-win32.png'));
    expect(find(report, 'default', 'changed screenshot').shots[0]?.expected?.sha1).toBe(sha1(baseline));
  });

  it('removes terminal escape codes from errors', () => {
    const failure = find(report, 'default', 'changed screenshot');
    expect(failure.error).toContain('toHaveScreenshot');
    expect(failure.error).not.toContain('\u001b');
  });

  it('reads screenshots named automatically', () => {
    expect(find(report, 'custom', 'auto named screenshot').shots.map((s) => s.name)).toEqual(['auto-named-screenshot-1']);
  });

  it('only sees the first failing screenshot of a test', () => {
    const failure = find(report, 'default', 'two screenshots in one test');
    expect(failure.shots.map((s) => s.name)).toEqual(['first']);
    expect(failure.stoppedAtScreenshot).toBe(true);
  });

  it('reads new screenshots with the path from the error message', () => {
    const failure = find(report, 'default', 'new screenshot');
    expect(failure.retries).toBe(0);
    expect(failure.stoppedAtScreenshot).toBe(false);
    expect(failure.missingSnapshots).toEqual([`${CI_PROJECT}/tests/visual.spec.ts-snapshots/brand-new-default-win32.png`]);
    const [shot] = failure.shots;
    expect(shot?.name).toBe('brand-new');
    expect(shot?.missingPath).toBe(`${CI_PROJECT}/tests/visual.spec.ts-snapshots/brand-new-default-win32.png`);
    expect(find(report, 'custom', 'new screenshot').shots[0]?.missingPath).toBe(
      `${CI_PROJECT}/tests/__screenshots__/custom/visual.spec.ts/brand-new.png`,
    );
  });

  it('keeps failures without screenshots, with their error', () => {
    const failure = find(report, 'custom', 'not a screenshot failure');
    expect(failure.shots).toEqual([]);
    expect(failure.stoppedAtScreenshot).toBe(false);
    expect(failure.error).toContain('toHaveText');
  });

  it('gives every failure and screenshot a unique id', () => {
    const ids = report.failures.flatMap((f) => [f.id, ...f.shots.map((s) => s.id)]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('readReport errors', () => {
  it('reports a missing folder as not found', async () => {
    const dir = path.join(tempDir(), 'playwright-report');
    await expect(readReport(dir)).rejects.toMatchObject({ code: 'not-found', name: 'ReportError' });
  });

  it('rejects an index.html that is not a Playwright report', async () => {
    const dir = tempDir();
    writeFiles(dir, { 'index.html': '<html><body>hello</body></html>' });
    const err = await readReport(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReportError);
    expect(err).toMatchObject({ code: 'invalid' });
    expect((err as ReportError).hint).toBeTruthy();
  });

  it('rejects a damaged embedded zip', async () => {
    const dir = tempDir();
    writeFiles(dir, { 'index.html': '<template>data:application/zip;base64,AAAAAAAA</template>' });
    await expect(readReport(dir)).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('readReport edge cases', () => {
  it('ignores attachments that point outside the report folder', async () => {
    const root = tempDir();
    writeFiles(root, { 'outside.png': png('outside') });
    const dir = writeReport(path.join(root, 'report'), [
      { title: 't', results: [{ attachments: [{ name: 'a-actual.png', path: '../outside.png' }] }] },
    ]);
    const report = await readReport(dir);
    expect(report.failures[0]?.shots).toEqual([]);
  });

  it('accepts errors stored as plain strings', async () => {
    const dir = writeReport(tempDir(), [{ title: 't', results: [{ errors: ['Error: \u001b[31mboom\u001b[39m'] }] }]);
    expect((await readReport(dir)).failures[0]?.error).toBe('Error: boom');
  });

  it('skips passed, flaky, skipped and expected-to-fail tests', async () => {
    const dir = writeReport(tempDir(), [
      { title: 'flaky', outcome: 'flaky', results: [{ status: 'failed' }, { status: 'passed' }] },
      { title: 'skipped', outcome: 'skipped', results: [{ status: 'skipped' }] },
      { title: 'marked with test.fail', outcome: 'expected', results: [{ status: 'failed' }] },
      { title: 'passed without outcome', results: [{ status: 'passed' }] },
      { title: 'failed without outcome', results: [{ status: 'failed' }] },
      { title: 'timed out', outcome: 'unexpected', results: [{ status: 'timedOut' }] },
    ]);
    const titles = (await readReport(dir)).failures.map((f) => f.title);
    expect(titles.sort()).toEqual(['failed without outcome', 'timed out']);
  });

  it('uses the attachments of the last retry', async () => {
    const dir = writeReport(tempDir(), [
      {
        title: 't',
        outcome: 'unexpected',
        results: [
          { attachments: [{ name: 'first-try-actual.png', content: png('1') }] },
          { attachments: [{ name: 'hero-actual.png', content: png('2') }, { name: 'hero-expected.png', content: png('3') }] },
        ],
      },
    ]);
    const [failure] = (await readReport(dir)).failures;
    expect(failure?.retries).toBe(1);
    expect(failure?.shots.map((s) => s.name)).toEqual(['hero']);
    expect(failure?.shots[0]?.actual.sha1).toBe(sha1(png('2')));
  });

  it('pairs each missing snapshot with the screenshot whose name fits best', async () => {
    const dir = writeReport(tempDir(), [
      {
        title: 't',
        results: [
          {
            errors: [
              "Error: A snapshot doesn't exist at /home/runner/work/r/r/s/hero-large-chromium-linux.png, writing actual.",
              "Error: A snapshot doesn't exist at /home/runner/work/r/r/s/hero-chromium-linux.png, writing actual.",
            ],
            attachments: [
              { name: 'hero-actual.png', content: png('h') },
              { name: 'hero-expected.png', content: png('h') },
              { name: 'hero-large-actual.png', content: png('hl') },
              { name: 'hero-large-expected.png', content: png('hl') },
            ],
          },
        ],
      },
    ]);
    const shots = (await readReport(dir)).failures[0]?.shots ?? [];
    expect(Object.fromEntries(shots.map((s) => [s.name, s.missingPath]))).toEqual({
      hero: '/home/runner/work/r/r/s/hero-chromium-linux.png',
      'hero-large': '/home/runner/work/r/r/s/hero-large-chromium-linux.png',
    });
  });

  it('never treats a changed screenshot as new', async () => {
    // A missing snapshot reported without any image (update mode "none") next to a real mismatch.
    const dir = writeReport(tempDir(), [
      {
        title: 't',
        results: [
          {
            errors: ["Error: A snapshot doesn't exist at C:\\work\\app\\tests\\x.spec.ts-snapshots\\hero-chromium-win32.png."],
            attachments: [
              { name: 'hero-actual.png', content: png('new look') },
              { name: 'hero-expected.png', content: png('old look') },
            ],
          },
        ],
      },
    ]);
    const [failure] = (await readReport(dir)).failures;
    expect(failure?.missingSnapshots).toEqual(['C:\\work\\app\\tests\\x.spec.ts-snapshots\\hero-chromium-win32.png']);
    expect(failure?.shots[0]?.missingPath).toBeNull();
  });

  it('pairs a single leftover missing snapshot even when the names differ', async () => {
    // A name used twice in one test gets a "-1" suffix in the attachment but not in the snapshot path.
    const dir = writeReport(tempDir(), [
      {
        title: 't',
        results: [
          {
            errors: ["Error: A snapshot doesn't exist at /home/runner/work/r/r/s/hero-chromium-linux.png, writing actual."],
            attachments: [{ name: 'hero-1-actual.png', content: png('x') }],
          },
        ],
      },
    ]);
    expect((await readReport(dir)).failures[0]?.shots[0]?.missingPath).toBe('/home/runner/work/r/r/s/hero-chromium-linux.png');
  });

  it('marks a screenshot whose image file is missing', async () => {
    const dir = writeReport(tempDir(), [
      { title: 't', results: [{ attachments: [{ name: 'hero-actual.png', path: 'data/0000.png' }] }] },
    ]);
    const shot = (await readReport(dir)).failures[0]?.shots[0];
    expect(shot?.actual.sha1).toBeNull();
    expect(shot?.actual.file).toBe(path.join(dir, 'data', '0000.png'));
  });
});

describe('reportPlatform', () => {
  function shotFailure(error: string, withShot = true): Failure {
    const image = { file: '/r/a.png', sha1: 'a' };
    return {
      id: 't',
      title: 't',
      titlePath: ['t'],
      projectName: 'chromium',
      file: 'a.spec.ts',
      line: 1,
      column: 1,
      status: 'failed',
      retries: 0,
      error,
      shots: withShot ? [{ id: 't:0', name: 'hero', actual: image, expected: image, diff: null, missingPath: null }] : [],
      missingSnapshots: [],
      stoppedAtScreenshot: false,
    };
  }

  it.each([
    ['a snapshot file name', "A snapshot doesn't exist at /__w/app/app/tests/a.spec.ts-snapshots/hero-chromium-linux.png, writing actual.", 'linux'],
    ['the expected path of older versions', 'Expected: /Users/runner/work/app/app/tests/a.spec.ts-snapshots/hero-chromium-darwin.png', 'darwin'],
    ['a Windows stack trace', '    at C:\\work\\app\\tests\\a.spec.ts:17:36', 'win32'],
    ['a macOS stack trace', '    at /Users/me/app/tests/a.spec.ts:17:36', 'darwin'],
    ['a Linux stack trace', '    at /home/me/app/tests/a.spec.ts:17:36', 'linux'],
  ])('finds the system in %s', (_, error, platform) => {
    expect(reportPlatform([shotFailure(error)])).toBe(platform);
  });

  it('prefers snapshot file names to the shape of paths', () => {
    // Saved fixtures rewrite Windows paths to /home/runner/..., but keep the file names.
    const error = "A snapshot doesn't exist at /home/runner/work/a/a/shots/hero-chromium-win32.png, writing actual.\n    at /home/runner/work/a/a/a.spec.ts:3:1";
    expect(reportPlatform([shotFailure(error)])).toBe('win32');
  });

  it('gives no answer without clues or with clues that disagree', () => {
    expect(reportPlatform([shotFailure('3200 pixels (ratio 1.00 of all image pixels) are different.')])).toBeNull();
    expect(reportPlatform([shotFailure('Expected pattern: /Welcome back/ at http://localhost:3000/home.js')])).toBeNull();
    expect(reportPlatform([shotFailure('    at C:\\app\\a.spec.ts:1:1'), shotFailure('    at /home/me/app/a.spec.ts:1:1')])).toBeNull();
  });

  it('only looks at screenshot failures', () => {
    expect(reportPlatform([shotFailure('    at C:\\app\\a.spec.ts:1:1', false), shotFailure('    at /home/me/app/a.spec.ts:1:1')])).toBe('linux');
  });
});

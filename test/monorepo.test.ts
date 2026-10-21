import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGit } from '../src/core/git.js';
import { readReport } from '../src/core/report-reader.js';
import { loadBaselines, resolveReport } from '../src/core/resolver.js';
import type { Resolution } from '../src/core/types.js';
import { writeBaseline } from '../src/core/writer.js';
import { isolateGit, png, tempDir, writeFiles, writeReport } from './helpers.js';

const SNAPSHOTS = 'packages/e2e/tests/home.spec.ts-snapshots';

/**
 * A repository with the Playwright project in packages/e2e, a copy of one
 * baseline elsewhere, and a report folder inside the project that git does
 * not ignore.
 */
async function makeMonorepo() {
  const root = tempDir();
  await runGit(['init', '-q'], root);
  writeFiles(root, {
    'package.json': '{}',
    [`${SNAPSHOTS}/hero-chromium-linux.png`]: png('hero old'),
    'docs/hero-copy.png': png('hero old'),
    [`${SNAPSHOTS}/logo-chromium-linux.png`]: png('logo old'),
  });
  await runGit(['add', 'package.json', `${SNAPSHOTS}/hero-chromium-linux.png`, 'docs/hero-copy.png'], root);
  await runGit(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init'], root);

  const project = path.join(root, 'packages', 'e2e');
  const reportDir = path.join(project, 'pw-report');
  const missing = (file: string) => `Error: A snapshot doesn't exist at ${file}, writing actual.`;
  writeReport(reportDir, [
    {
      title: 'hero',
      testId: 'hero',
      results: [
        {
          attachments: [
            { name: 'hero-actual.png', content: png('hero new') },
            { name: 'hero-expected.png', content: png('hero old') },
          ],
        },
      ],
    },
    {
      title: 'logo, baseline not committed yet',
      testId: 'logo',
      results: [
        {
          attachments: [
            { name: 'logo-actual.png', content: png('logo new') },
            { name: 'logo-expected.png', content: png('logo old') },
          ],
        },
      ],
    },
    {
      title: 'new on CI',
      testId: 'ci',
      results: [
        {
          errors: [missing(`/home/runner/work/app/app/${SNAPSHOTS}/ci-chromium-linux.png`)],
          attachments: [{ name: 'ci-actual.png', content: png('ci') }],
        },
      ],
    },
    {
      title: 'new locally',
      testId: 'local',
      results: [
        {
          errors: [missing(path.join(project, 'tests', 'home.spec.ts-snapshots', 'local-chromium-linux.png'))],
          attachments: [{ name: 'local-actual.png', content: png('local') }],
        },
      ],
    },
  ]);
  return { root, project, reportDir };
}

function targets(resolutions: Map<string, Resolution>) {
  return Object.fromEntries(
    [...resolutions].map(([id, r]) => [id.split(':')[0], r.status === 'resolved' ? `${r.via} ${r.target}` : r.reason]),
  );
}

describe('a Playwright project in a subfolder', () => {
  isolateGit();

  it('resolves every path relative to the repository root', async () => {
    const { project, reportDir } = await makeMonorepo();
    const report = await readReport(reportDir);
    const baselines = await loadBaselines(project, { exclude: [reportDir] });
    expect(targets(resolveReport(report, baselines))).toEqual({
      hero: `tracked ${SNAPSHOTS}/hero-chromium-linux.png`,
      logo: `untracked ${SNAPSHOTS}/logo-chromium-linux.png`,
      ci: `path ${SNAPSHOTS}/ci-chromium-linux.png`,
      local: `path ${SNAPSHOTS}/local-chromium-linux.png`,
    });
  });

  it('gives the same answer from the repository root', async () => {
    const { root, reportDir } = await makeMonorepo();
    const report = await readReport(reportDir);
    // From the root, docs/hero-copy.png is in scope too: the name tells them apart.
    const baselines = await loadBaselines(root, { exclude: [reportDir] });
    expect(targets(resolveReport(report, baselines))).toMatchObject({
      hero: `tracked ${SNAPSHOTS}/hero-chromium-linux.png`,
      logo: `untracked ${SNAPSHOTS}/logo-chromium-linux.png`,
    });
  });

  it('never offers the files of the report itself', async () => {
    const { project, reportDir } = await makeMonorepo();
    const baselines = await loadBaselines(project, { exclude: [reportDir] });
    const files = [...baselines.index.values(), ...(baselines.untrackedIndex?.values() ?? [])].flat();
    expect(files.some((f) => f.includes('pw-report'))).toBe(false);
  });

  it('writes accepted screenshots where git expects them', async () => {
    const { root, project, reportDir } = await makeMonorepo();
    const report = await readReport(reportDir);
    const baselines = await loadBaselines(project, { exclude: [reportDir] });
    const resolutions = resolveReport(report, baselines);
    for (const failure of report.failures) {
      for (const shot of failure.shots) {
        const r = resolutions.get(shot.id);
        if (r?.status === 'resolved') await writeBaseline(baselines.root, r.target, shot.actual.file);
      }
    }
    const status = await runGit(['-c', 'core.quotepath=off', 'status', '--porcelain', '--untracked-files=all', '--', SNAPSHOTS], root);
    expect(status.trimEnd().split('\n').sort()).toEqual([
      ` M ${SNAPSHOTS}/hero-chromium-linux.png`,
      `?? ${SNAPSHOTS}/ci-chromium-linux.png`,
      `?? ${SNAPSHOTS}/local-chromium-linux.png`,
      `?? ${SNAPSHOTS}/logo-chromium-linux.png`,
    ]);
  });
});

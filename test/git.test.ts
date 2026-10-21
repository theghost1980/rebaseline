import { realpathSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listTrackedPngs, listUntrackedPngs, repoRoot, runGit } from '../src/core/git.js';
import { loadBaselines } from '../src/core/resolver.js';
import { isolateGit, png, sha1, tempDir, writeFiles } from './helpers.js';

async function makeRepo(): Promise<string> {
  const root = tempDir();
  await runGit(['init', '-q'], root);
  writeFiles(root, {
    'README.md': 'x',
    '.gitignore': 'ignored/\n',
    'e2e/a.spec.ts-snapshots/hero-chromium-linux.png': png('hero'),
    'e2e/__screenshots__/firefox/nav.png': png('nav'),
    'e2e/test-results/a-hero/hero-actual.png': png('actual'),
    'e2e/test-results/a-new/new-actual.png': png('untracked output'),
    'playwright-report/data/123.png': png('report'),
    'docs/logo.PNG': png('logo'),
    'e2e/untracked.png': png('untracked'),
    'e2e/ignored/skip.png': png('ignored'),
  });
  await runGit(
    [
      'add',
      'README.md',
      'e2e/a.spec.ts-snapshots',
      'e2e/__screenshots__',
      'e2e/test-results/a-hero',
      'playwright-report',
      'docs',
    ],
    root,
  );
  return root;
}

describe('git helpers', () => {
  isolateGit();

  it('finds the repository root from a subfolder', async () => {
    const root = await makeRepo();
    expect(realpathSync.native(await repoRoot(path.join(root, 'e2e')))).toBe(realpathSync.native(root));
  });

  it('lists tracked PNG files, leaving out test output folders and untracked files', async () => {
    const root = await makeRepo();
    expect((await listTrackedPngs(root)).sort()).toEqual([
      'docs/logo.PNG',
      'e2e/__screenshots__/firefox/nav.png',
      'e2e/a.spec.ts-snapshots/hero-chromium-linux.png',
    ]);
  });

  it('lists only the files under the current folder, with paths from the root', async () => {
    const root = await makeRepo();
    expect((await listTrackedPngs(path.join(root, 'e2e', '__screenshots__'))).sort()).toEqual([
      'e2e/__screenshots__/firefox/nav.png',
    ]);
  });

  it('loads the baselines under the current folder', async () => {
    const root = await makeRepo();
    const baselines = await loadBaselines(path.join(root, 'e2e'));
    expect(realpathSync.native(baselines.root)).toBe(realpathSync.native(root));
    expect(baselines.index.get(sha1(png('hero')))).toEqual(['e2e/a.spec.ts-snapshots/hero-chromium-linux.png']);
    expect(baselines.index.has(sha1(png('logo')))).toBe(false);
    expect(baselines.index.has(sha1(png('actual')))).toBe(false);
    expect(baselines.untrackedIndex?.get(sha1(png('untracked')))).toEqual(['e2e/untracked.png']);
  });

  it('lists untracked PNG files that are not ignored, leaving out test output folders', async () => {
    const root = await makeRepo();
    expect(await listUntrackedPngs(root)).toEqual(['e2e/untracked.png']);
  });

  it('leaves out the excluded folders', async () => {
    const root = await makeRepo();
    const baselines = await loadBaselines(root, { exclude: [path.join(root, 'e2e')] });
    expect([...baselines.index.values()].flat()).toEqual(['docs/logo.PNG']);
    expect([...(baselines.untrackedIndex?.values() ?? [])].flat()).toEqual([]);
  });

  it('explains when the folder is not a git repository', async () => {
    const dir = tempDir();
    await expect(repoRoot(dir)).rejects.toMatchObject({
      name: 'UserError',
      message: expect.stringContaining('is not inside a git repository'),
      hint: 'Run rebaseline from your project folder.',
    });
  });
});

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readReport } from '../src/core/report-reader.js';
import {
  type Baselines,
  hashFiles,
  narrowCandidates,
  projectPathName,
  resolveReport,
  resolveShot,
  stripRunnerPrefix,
  toRepoPath,
} from '../src/core/resolver.js';
import type { Shot } from '../src/core/types.js';
import { fixtureDir, png, sha1, tempDir, writeFiles } from './helpers.js';

const PROJECT = 'fixtures/pw-project';

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')],
  );
}

/** The saved baseline tree, indexed as if it lived at fixtures/pw-project in a repository. */
async function fixtureBaselines(): Promise<Baselines> {
  const dir = path.join(fixtureDir, 'baselines');
  const byFile = await hashFiles(dir, listFiles(dir));
  const index = new Map([...byFile].map(([hash, files]) => [hash, files.map((f) => `${PROJECT}/${f}`)]));
  return { root: tempDir(), index };
}

function shot(overrides: Partial<Shot>): Shot {
  return {
    id: 's',
    name: 'hero',
    actual: { file: 'actual.png', sha1: sha1('actual') },
    expected: { file: 'expected.png', sha1: sha1('expected') },
    diff: null,
    missingPath: null,
    ...overrides,
  };
}

describe('resolveReport with the saved Playwright 1.64.1 report', async () => {
  const report = await readReport(path.join(fixtureDir, 'report'));
  const baselines = await fixtureBaselines();
  const resolutions = resolveReport(report, baselines);

  const targetOf = (projectName: string, title: string) => {
    const failure = report.failures.find((f) => f.projectName === projectName && f.title === title);
    const id = failure?.shots[0]?.id;
    return id ? resolutions.get(id) : undefined;
  };

  it('covers baselines that share the same image', () => {
    const failure = report.failures.find((f) => f.projectName === 'default' && f.title === 'changed screenshot');
    const hash = failure?.shots[0]?.expected?.sha1 ?? '';
    expect(baselines.index.get(hash)).toHaveLength(4);
  });

  it.each([
    ['default', 'changed screenshot', 'tests/visual.spec.ts-snapshots/hero-default-win32.png'],
    ['custom', 'changed screenshot', 'tests/__screenshots__/custom/visual.spec.ts/hero.png'],
    ['default', 'auto named screenshot', 'tests/visual.spec.ts-snapshots/auto-named-screenshot-1-default-win32.png'],
    ['custom', 'auto named screenshot', 'tests/__screenshots__/custom/visual.spec.ts/auto-named-screenshot-1.png'],
    ['default', 'two screenshots in one test', 'tests/visual.spec.ts-snapshots/first-default-win32.png'],
    ['custom', 'two screenshots in one test', 'tests/__screenshots__/custom/visual.spec.ts/first.png'],
  ])('resolves the changed screenshot of %s / %s', (project, title, target) => {
    expect(targetOf(project, title)).toEqual({ status: 'resolved', kind: 'changed', target: `${PROJECT}/${target}` });
  });

  it.each([
    ['default', 'tests/visual.spec.ts-snapshots/brand-new-default-win32.png'],
    ['custom', 'tests/__screenshots__/custom/visual.spec.ts/brand-new.png'],
  ])('resolves the new screenshot of %s from the reported path', (project, target) => {
    expect(targetOf(project, 'new screenshot')).toEqual({ status: 'resolved', kind: 'new', target: `${PROJECT}/${target}` });
  });

  it('resolves every screenshot in the report', () => {
    expect([...resolutions.values()].every((r) => r.status === 'resolved')).toBe(true);
    expect(resolutions.size).toBe(8);
  });
});

describe('stripRunnerPrefix', () => {
  it.each([
    ['Linux', '/home/runner/work/app/app/tests/a.spec.ts-snapshots/hero-chromium-linux.png'],
    ['macOS', '/Users/runner/work/app/app/tests/a.spec.ts-snapshots/hero-chromium-linux.png'],
    ['Windows', 'D:\\a\\app\\app\\tests\\a.spec.ts-snapshots\\hero-chromium-linux.png'],
    ['Windows, lower-case drive', 'd:\\a\\app\\app\\tests\\a.spec.ts-snapshots\\hero-chromium-linux.png'],
    ['Windows, another drive', 'C:\\a\\app\\app\\tests\\a.spec.ts-snapshots\\hero-chromium-linux.png'],
    ['Windows, forward slashes', 'D:/a/app/app/tests/a.spec.ts-snapshots/hero-chromium-linux.png'],
    ['job container', '/__w/app/app/tests/a.spec.ts-snapshots/hero-chromium-linux.png'],
    ['self-hosted Linux runner', '/opt/actions-runner/_work/app/app/tests/a.spec.ts-snapshots/hero-chromium-linux.png'],
    ['self-hosted Windows runner', 'C:\\actions-runner\\_work\\app\\app\\tests\\a.spec.ts-snapshots\\hero-chromium-linux.png'],
  ])('strips the %s workspace', (_name, raw) => {
    expect(stripRunnerPrefix(raw)).toBe('tests/a.spec.ts-snapshots/hero-chromium-linux.png');
  });

  it('keeps dots and dashes in repository names', () => {
    expect(stripRunnerPrefix('/home/runner/work/my.web-app/my.web-app/e2e/x.png')).toBe('e2e/x.png');
    expect(stripRunnerPrefix('D:\\a\\my.web-app\\my.web-app\\e2e\\x.png')).toBe('e2e/x.png');
  });

  it.each([
    ['a local path', '/home/alice/app/tests/x.png'],
    ['a Windows path that is not a runner workspace', 'D:\\abc\\app\\app\\x.png'],
    ['a workspace with a single repository folder', '/home/runner/work/app/x.png'],
    ['two different repository folders', '/home/runner/work/app/other/x.png'],
    ['a relative path', 'tests/x.png'],
  ])('returns null for %s', (_name, raw) => {
    expect(stripRunnerPrefix(raw)).toBeNull();
  });
});

describe('toRepoPath', () => {
  it('turns runner paths into repository paths', () => {
    expect(toRepoPath('D:\\a\\app\\app\\e2e\\shots\\x.png', tempDir())).toEqual({ path: 'e2e/shots/x.png' });
  });

  it('turns local absolute paths inside the repository into repository paths', () => {
    const root = tempDir();
    expect(toRepoPath(path.join(root, 'e2e', 'shots', 'x.png'), root)).toEqual({ path: 'e2e/shots/x.png' });
  });

  it('rejects local paths outside the repository', () => {
    const root = tempDir();
    expect(toRepoPath(path.join(path.dirname(root), 'elsewhere', 'x.png'), root)).toEqual({ reason: 'outside-repo' });
  });

  it('rejects absolute paths from another operating system', () => {
    const foreign = process.platform === 'win32' ? '/Users/alice/app/x.png' : 'C:\\Users\\alice\\app\\x.png';
    // On Windows "/Users/..." is absolute on the current drive, outside the repository too.
    expect(toRepoPath(foreign, tempDir())).toEqual({ reason: 'outside-repo' });
  });

  it('rejects relative paths and paths that climb out', () => {
    expect(toRepoPath('tests/x.png', tempDir())).toEqual({ reason: 'invalid-path' });
    expect(toRepoPath('/home/runner/work/app/app/../../etc/x.png', tempDir())).toEqual({ reason: 'invalid-path' });
  });
});

describe('resolveShot', () => {
  const root = tempDir();
  const baselines = (entries: Record<string, string[]>): Baselines => ({ root, index: new Map(Object.entries(entries)) });
  const expectedHash = sha1('expected');

  it('resolves a single match even when its name is different', () => {
    const result = resolveShot({ projectName: 'chromium' }, shot({}), baselines({ [expectedHash]: ['shots/renamed.png'] }));
    expect(result).toEqual({ status: 'resolved', kind: 'changed', target: 'shots/renamed.png' });
  });

  it('breaks ties with the project name and the screenshot name', () => {
    const files = ['a/chromium/hero.png', 'a/firefox/hero.png', 'a/chromium/logo.png'];
    expect(resolveShot({ projectName: 'firefox' }, shot({}), baselines({ [expectedHash]: files }))).toEqual({
      status: 'resolved',
      kind: 'changed',
      target: 'a/firefox/hero.png',
    });
  });

  it('matches project names the way Playwright writes them in paths', () => {
    const files = ['s/hero-Mobile-Chrome-linux.png', 's/hero-Desktop-Chrome-linux.png'];
    expect(resolveShot({ projectName: 'Mobile Chrome' }, shot({}), baselines({ [expectedHash]: files }))).toMatchObject({
      status: 'resolved',
      target: 's/hero-Mobile-Chrome-linux.png',
    });
  });

  it('leaves remaining ties unresolved and lists the candidates', () => {
    const files = ['a/chromium/hero.png', 'b/chromium/hero.png', 'c/firefox/hero.png'];
    expect(resolveShot({ projectName: 'chromium' }, shot({}), baselines({ [expectedHash]: files }))).toEqual({
      status: 'unresolved',
      kind: 'changed',
      reason: 'ambiguous',
      candidates: ['a/chromium/hero.png', 'b/chromium/hero.png'],
    });
  });

  it('lists every candidate when none of them fits the project and name', () => {
    const files = ['a/firefox/logo.png', 'b/webkit/logo.png'];
    expect(resolveShot({ projectName: 'chromium' }, shot({}), baselines({ [expectedHash]: files }))).toMatchObject({
      reason: 'ambiguous',
      candidates: files,
    });
  });

  it('reports when nothing matches', () => {
    expect(resolveShot({ projectName: 'chromium' }, shot({}), baselines({}))).toMatchObject({ status: 'unresolved', reason: 'no-match' });
  });

  it('reports a changed screenshot without expected image', () => {
    expect(resolveShot({ projectName: 'chromium' }, shot({ expected: null }), baselines({}))).toMatchObject({
      status: 'unresolved',
      kind: 'changed',
      reason: 'no-expected-image',
    });
  });

  it('reports a screenshot whose actual image is missing', () => {
    const missing = shot({ actual: { file: 'actual.png', sha1: null } });
    expect(resolveShot({ projectName: 'chromium' }, missing, baselines({}))).toMatchObject({ reason: 'missing-image' });
  });

  it('uses the reported path for new screenshots, even when the image matches a baseline', () => {
    const fresh = shot({ missingPath: '/home/runner/work/app/app/e2e/new.png', expected: { file: 'e.png', sha1: expectedHash } });
    expect(resolveShot({ projectName: 'chromium' }, fresh, baselines({ [expectedHash]: ['e2e/other.png'] }))).toEqual({
      status: 'resolved',
      kind: 'new',
      target: 'e2e/new.png',
    });
  });

  it('reports new screenshots whose path is outside the repository', () => {
    const fresh = shot({ missingPath: '/home/alice/other-project/new.png' });
    expect(resolveShot({ projectName: 'chromium' }, fresh, baselines({}))).toMatchObject({ kind: 'new', reason: 'outside-repo' });
  });
});

describe('helpers', () => {
  it('writes project names like Playwright does', () => {
    expect(projectPathName('Mobile Chrome')).toBe('Mobile-Chrome');
    expect(projectPathName('chromium')).toBe('chromium');
    expect(projectPathName('setup/db')).toBe('setup-db');
    expect(projectPathName('v1.2 chrome')).toBe('v1.2-chrome');
  });

  it('narrows candidates by the last segment of the screenshot name', () => {
    expect(narrowCandidates(['x/chromium/nav/menu.png', 'x/chromium/menu-old.png'], 'chromium', 'nav/menu')).toEqual([
      'x/chromium/nav/menu.png',
      'x/chromium/menu-old.png',
    ]);
  });

  it('hashes files and skips the ones that are missing', async () => {
    const root = tempDir();
    writeFiles(root, { 'a.png': png('same'), 'b/c.png': png('same'), 'd.png': png('other') });
    const index = await hashFiles(root, ['a.png', 'b/c.png', 'd.png', 'gone.png']);
    expect(index.get(sha1(png('same')))).toEqual(['a.png', 'b/c.png']);
    expect(index.get(sha1(png('other')))).toEqual(['d.png']);
    expect([...index.values()].flat()).not.toContain('gone.png');
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readReport } from '../src/core/report-reader.js';
import { type Baselines, hashFiles, resolveReport } from '../src/core/resolver.js';
import { repoRoot, tempDir } from './helpers.js';

// The same checks for every saved report: one per Playwright version and platform.

const reportsDir = path.join(repoRoot, 'fixtures', 'reports');
const saved = readdirSync(reportsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^pw-\d/.test(e.name))
  .map((e) => e.name)
  .sort();

interface Meta {
  playwright: string;
  platform: string;
  projectPath: string;
  newSnapshots: string[];
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')],
  );
}

describe.each(saved)('saved report %s', async (name) => {
  const dir = path.join(reportsDir, name);
  const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as Meta;
  const files = listFiles(path.join(dir, 'baselines'));
  const inRepo = (file: string) => `${meta.projectPath}/${file}`;

  // The baseline tree, indexed as if it lived at its project path in a repository.
  const byHash = await hashFiles(path.join(dir, 'baselines'), files);
  const baselines: Baselines = { root: tempDir(), index: new Map([...byHash].map(([hash, list]) => [hash, list.map(inRepo)])) };
  const report = await readReport(path.join(dir, 'report'));
  const resolutions = resolveReport(report, baselines);

  const failure = (project: string, title: string) => report.failures.find((f) => f.projectName === project && f.title === title);
  const resolution = (project: string, title: string) => resolutions.get(failure(project, title)?.shots[0]?.id ?? '');
  const snapshots = {
    default: (base: string) => `tests/visual.spec.ts-snapshots/${base}-default-${meta.platform}.png`,
    custom: (base: string) => `tests/__screenshots__/custom/visual.spec.ts/${base}.png`,
  };

  it('knows the system the tests ran on', () => {
    expect(report.platform).toBe(meta.platform);
  });

  it('lists the failed tests with their screenshots', () => {
    for (const project of ['default', 'custom']) {
      expect(failure(project, 'changed screenshot')?.shots.map((s) => s.name)).toEqual(['hero']);
      expect(failure(project, 'auto named screenshot')?.shots).toHaveLength(1);
      // The test stops at the first difference, so only "first" is compared.
      expect(failure(project, 'two screenshots in one test')?.shots.map((s) => s.name)).toEqual(['first']);
      expect(failure(project, 'two screenshots in one test')?.stoppedAtScreenshot).toBe(true);
      expect(failure(project, 'not a screenshot failure')?.shots).toEqual([]);
      expect(failure(project, 'unchanged screenshot')).toBeUndefined();
    }
  });

  it.each(['default', 'custom'] as const)('resolves the changed screenshots of %s to their baselines', (project) => {
    for (const [title, base] of [
      ['changed screenshot', 'hero'],
      ['two screenshots in one test', 'first'],
    ] as const) {
      expect(resolution(project, title)).toEqual({ status: 'resolved', kind: 'changed', target: inRepo(snapshots[project](base)), via: 'tracked' });
    }
    const auto = resolution(project, 'auto named screenshot');
    expect(auto).toMatchObject({ status: 'resolved', kind: 'changed', via: 'tracked' });
    expect(files.map(inRepo)).toContain(auto?.status === 'resolved' ? auto.target : '');
  });

  it('resolves new screenshots to the paths Playwright reported', () => {
    const fresh = [...resolutions.values()].filter((r) => r.kind === 'new');
    for (const r of fresh) expect(r).toMatchObject({ status: 'resolved', via: 'path' });
    expect(meta.newSnapshots.map(inRepo)).toEqual(expect.arrayContaining(fresh.map((r) => (r.status === 'resolved' ? r.target : ''))));
  });

  it('resolves every screenshot', () => {
    expect([...resolutions.values()].filter((r) => r.status !== 'resolved')).toEqual([]);
  });
});

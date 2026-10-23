import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGit } from '../src/core/git.js';
import { mergeReports } from '../src/core/report-reader.js';
import type { Failure, Report } from '../src/core/types.js';
import { formatBytes, timeAgo } from '../src/lib/format.js';
import { runGh } from '../src/pull/gh.js';
import { currentBranch, findRepo, parseRemoteUrl, parseRepoName, repoName } from '../src/pull/repo.js';
import { type Artifact, parsePullRequestReference, parseRunReference, selectReportArtifacts } from '../src/pull/runs.js';
import { UserError } from '../src/lib/errors.js';
import { isolateGit, tempDir, writeFiles } from './helpers.js';

describe('repository names', () => {
  it.each([
    ['https://github.com/acme/shop.git', 'acme/shop'],
    ['https://github.com/acme/shop', 'acme/shop'],
    ['https://github.com/acme/shop/', 'acme/shop'],
    ['https://user:secret@github.com/acme/shop.git', 'acme/shop'],
    ['git@github.com:acme/shop.git', 'acme/shop'],
    ['ssh://git@github.com/acme/shop.git', 'acme/shop'],
    ['ssh://git@github.com:22/acme/shop', 'acme/shop'],
    ['https://www.github.com/acme/my.site', 'acme/my.site'],
    ['https://ghe.example.com/team/app.git', 'ghe.example.com/team/app'],
  ])('reads %s', (url, expected) => {
    const repo = parseRemoteUrl(url);
    expect(repo && repoName(repo)).toBe(expected);
  });

  it.each(['C:\\repos\\shop', '/srv/git/shop.git', 'file:///srv/git/shop.git', 'https://github.com/acme', 'https://github.com/a/b/c', ''])(
    'does not take %s for a GitHub repository',
    (url) => {
      expect(parseRemoteUrl(url)).toBeNull();
    },
  );

  it('reads owner/name and host/owner/name', () => {
    expect(parseRepoName('acme/shop')).toEqual({ host: 'github.com', owner: 'acme', name: 'shop' });
    expect(parseRepoName('ghe.example.com/team/app')).toEqual({ host: 'ghe.example.com', owner: 'team', name: 'app' });
    expect(parseRepoName('acme')).toBeNull();
    expect(parseRepoName('acme/../x')).toBeNull();
  });
});

describe('run and pull request references', () => {
  it('reads numbers and URLs', () => {
    expect(parseRunReference(123)).toEqual({ number: 123, repo: null });
    expect(parseRunReference('39556275964')).toEqual({ number: 39556275964, repo: null });
    expect(parseRunReference('https://github.com/acme/shop/actions/runs/42/attempts/2')).toEqual({
      number: 42,
      repo: { host: 'github.com', owner: 'acme', name: 'shop' },
    });
    expect(parseRunReference('https://github.com/acme/shop/actions/runs/42?pr=3')?.number).toBe(42);
    expect(parsePullRequestReference('#7')).toEqual({ number: 7, repo: null });
    expect(parsePullRequestReference('https://github.com/acme/shop/pull/7/files')?.repo).toEqual({ host: 'github.com', owner: 'acme', name: 'shop' });
  });

  it.each(['abc', '0', '-3', 'https://github.com/acme/shop/pull/7', 'https://example.com/runs/4'])('rejects %s as a run', (value) => {
    expect(parseRunReference(value)).toBeNull();
  });
});

function artifact(name: string, fields: Partial<Artifact> = {}): Artifact {
  return { id: 1, name, size_in_bytes: 10, expired: false, created_at: '2026-10-21T10:00:00Z', ...fields };
}

describe('choosing the report artifacts', () => {
  it('prefers playwright-report', () => {
    const result = selectReportArtifacts([artifact('coverage'), artifact('playwright-report'), artifact('playwright-report-old')]);
    expect(result).toEqual({ kind: 'html', artifacts: [artifact('playwright-report')] });
  });

  it('takes every shard, in numeric order', () => {
    const result = selectReportArtifacts([artifact('playwright-report-10'), artifact('playwright-report-2'), artifact('playwright-report-1')]);
    expect(result.kind === 'html' && result.artifacts.map((a) => a.name)).toEqual(['playwright-report-1', 'playwright-report-2', 'playwright-report-10']);
  });

  it('recognizes blob reports', () => {
    expect(selectReportArtifacts([artifact('blob-report-1'), artifact('blob-report-2')]).kind).toBe('blob');
  });

  it('finds nothing in other artifacts', () => {
    expect(selectReportArtifacts([artifact('coverage')])).toEqual({ kind: 'none' });
    expect(selectReportArtifacts([])).toEqual({ kind: 'none' });
  });

  it('matches a given name, where * is any text', () => {
    const all = [artifact('e2e-report-chromium'), artifact('e2e-report-firefox'), artifact('playwright-report')];
    expect(selectReportArtifacts(all, 'e2e-report-*').kind).toBe('html');
    expect(selectReportArtifacts(all, 'e2e-report-chromium')).toEqual({ kind: 'html', artifacts: [artifact('e2e-report-chromium')] });
    expect(selectReportArtifacts(all, 'e2e')).toEqual({ kind: 'none' });
  });

  it('keeps the newest artifact when a re-run uploaded the same name', () => {
    const old = artifact('playwright-report', { id: 1, created_at: '2026-10-20T10:00:00Z' });
    const fresh = artifact('playwright-report', { id: 2, created_at: '2026-10-21T10:00:00Z' });
    expect(selectReportArtifacts([fresh, old])).toEqual({ kind: 'html', artifacts: [fresh] });
  });
});

function failure(id: string, projectName: string, file: string): Failure {
  const image = { file: `/r/${id}.png`, sha1: id };
  return {
    id,
    title: id,
    titlePath: [id],
    projectName,
    file,
    line: 1,
    column: 1,
    status: 'failed',
    retries: 0,
    error: '',
    shots: [{ id: `${id}:0`, name: id, actual: image, expected: null, diff: null, missingPath: null }],
    missingSnapshots: [],
    stoppedAtScreenshot: false,
  };
}

describe('joining the reports of several shards', () => {
  it('keeps every failure with unique ids, in project order', () => {
    const a: Report = { dir: '/a', projectNames: ['desktop', 'mobile'], failures: [failure('t1', 'mobile', 'a.spec.ts')], platform: 'linux' };
    const b: Report = {
      dir: '/b',
      projectNames: ['desktop', 'mobile'],
      failures: [failure('t1', 'desktop', 'b.spec.ts'), failure('t2', 'desktop', 'a.spec.ts')],
      platform: 'linux',
    };
    const merged = mergeReports([a, b], '/all');
    expect(merged.dir).toBe('/all');
    expect(merged.platform).toBe('linux');
    expect(mergeReports([a, { ...b, platform: null }], '/all').platform).toBeNull();
    expect(merged.projectNames).toEqual(['desktop', 'mobile']);
    expect(merged.failures.map((f) => `${f.projectName} ${f.file} ${f.id}`)).toEqual(['desktop a.spec.ts t2', 'desktop b.spec.ts t1-2', 'mobile a.spec.ts t1']);
    expect(merged.failures.flatMap((f) => f.shots.map((s) => s.id))).toEqual(['t2:0', 't1-2:0', 't1:0']);
  });
});

describe('formatting', () => {
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2500)).toBe('2.4 KB');
    expect(formatBytes(2_500_000)).toBe('2.4 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB');
  });

  it('says how long ago', () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    expect(timeAgo('2026-10-21T11:59:30Z', now)).toBe('just now');
    expect(timeAgo('2026-10-21T11:59:00Z', now)).toBe('1 minute ago');
    expect(timeAgo('2026-10-21T09:00:00Z', now)).toBe('3 hours ago');
    expect(timeAgo('2026-10-17T12:00:00Z', now)).toBe('4 days ago');
  });
});

describe('finding the repository and branch', () => {
  isolateGit();
  let savedRepo: string | undefined;
  afterEach(() => {
    if (savedRepo === undefined) delete process.env.GH_REPO;
    else process.env.GH_REPO = savedRepo;
  });

  async function repo(remotes: Record<string, string>): Promise<string> {
    savedRepo = process.env.GH_REPO;
    delete process.env.GH_REPO;
    const root = tempDir();
    await runGit(['init', '-q', '-b', 'main'], root);
    for (const [name, url] of Object.entries(remotes)) await runGit(['remote', 'add', name, url], root);
    return root;
  }

  it('uses origin', async () => {
    const root = await repo({ upstream: 'https://github.com/acme/shop.git', origin: 'git@github.com:me/shop.git' });
    expect(repoName(await findRepo(root))).toBe('me/shop');
  });

  it('uses the remote chosen with gh repo set-default', async () => {
    const root = await repo({ upstream: 'https://github.com/acme/shop.git', origin: 'git@github.com:me/shop.git' });
    await runGit(['config', 'remote.upstream.gh-resolved', 'base'], root);
    expect(repoName(await findRepo(root))).toBe('acme/shop');
  });

  it('uses the only remote, whatever its name', async () => {
    const root = await repo({ github: 'https://github.com/acme/shop' });
    expect(repoName(await findRepo(root))).toBe('acme/shop');
  });

  it('lets --repo and GH_REPO choose', async () => {
    const root = await repo({ origin: 'https://github.com/acme/shop' });
    expect(repoName(await findRepo(root, 'other/site'))).toBe('other/site');
    process.env.GH_REPO = 'env/site';
    expect(repoName(await findRepo(root))).toBe('env/site');
    await expect(findRepo(root, 'nope')).rejects.toThrow('Invalid --repo: nope');
  });

  it('explains when there is no usable remote, without printing credentials', async () => {
    await expect(findRepo(await repo({}))).rejects.toThrow('This repository has no git remote');
    await expect(findRepo(await repo({ a: 'https://github.com/a/b', b: 'https://github.com/c/d' }))).rejects.toThrow('several git remotes');
    const err = await findRepo(await repo({ origin: 'https://user:s3cret@gitlab.example.com/group/sub/app.git' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toBe('The origin remote is not a GitHub repository: https://gitlab.example.com/group/sub/app.git');
  });

  it('uses the remote branch name the local branch tracks', async () => {
    const root = await repo({ origin: 'https://github.com/acme/shop' });
    await runGit(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'], root);
    expect(await currentBranch(root)).toBe('main');
    await runGit(['checkout', '-q', '-b', 'local-name'], root);
    await runGit(['config', 'branch.local-name.merge', 'refs/heads/feature/x'], root);
    expect(await currentBranch(root)).toBe('feature/x');
    await runGit(['checkout', '-q', '--detach'], root);
    await expect(currentBranch(root)).rejects.toThrow('Your checkout is not on a branch');
  });
});

describe('running gh', () => {
  let saved: string | undefined;
  afterEach(() => {
    if (saved === undefined) delete process.env.REBASELINE_GH;
    else process.env.REBASELINE_GH = saved;
  });

  /** Points REBASELINE_GH at a script that prints `stderr` and exits with `code`. */
  function fakeGh(code: number, stderr: string, stdout = ''): string {
    saved = process.env.REBASELINE_GH;
    const dir = tempDir();
    writeFiles(dir, {
      'gh.cjs': `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(${code});`,
    });
    process.env.REBASELINE_GH = path.join(dir, 'gh.cjs');
    return dir;
  }

  const notFound = () => new UserError('acme/shop was not found');

  it('returns the output', async () => {
    const cwd = fakeGh(0, '', '[1,2]');
    expect(await runGh(['run', 'list'], { cwd })).toBe('[1,2]');
  });

  it.each([
    [4, 'To get started with GitHub CLI, please run:  gh auth login', 'The GitHub CLI (gh) is not signed in'],
    [1, 'failed to get runs: HTTP 401: Bad credentials (https://api.github.com/x)', 'GitHub rejected the credentials of the GitHub CLI (gh)'],
    [1, 'GraphQL: Resource not accessible by personal access token (repository.pullRequest)', 'The GitHub token cannot read the runs'],
    [1, 'HTTP 403: API rate limit exceeded for user', 'GitHub API rate limit reached'],
    [1, 'failed to get runs: HTTP 404: Not Found (https://api.github.com/x)', 'acme/shop was not found'],
    [1, "GraphQL: Could not resolve to a Repository with the name 'acme/shop'. (repository)", 'acme/shop was not found'],
    [1, 'unknown flag: --commit', 'This version of the GitHub CLI (gh) is too old'],
    [1, 'something else went wrong\nmore detail', 'gh run list failed: something else went wrong'],
  ])('explains exit code %i with "%s"', async (code, stderr, message) => {
    const cwd = fakeGh(code, stderr);
    await expect(runGh(['run', 'list'], { cwd, notFound, what: 'the runs' })).rejects.toThrow(message);
  });

  it('explains when gh is not installed', async () => {
    saved = process.env.REBASELINE_GH;
    delete process.env.REBASELINE_GH;
    const savedPath = process.env.PATH;
    process.env.PATH = tempDir();
    try {
      await expect(runGh(['--version'], { cwd: tempDir() })).rejects.toThrow('The GitHub CLI (gh) was not found');
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

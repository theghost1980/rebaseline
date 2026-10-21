import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runGit } from '../src/core/git.js';
import type { Artifact, Run } from '../src/pull/runs.js';
import { connect, makeRepo, runCli } from './e2e-helpers.js';
import { fixtureDir, isolateGit, png, tempDir, writeFiles, writeReport } from './helpers.js';

const fakeGhScript = fileURLToPath(new URL('./fake-gh.cjs', import.meta.url));
const savedReport = path.join(fixtureDir, 'report');

interface FakeData {
  runs?: Run[];
  artifacts?: Record<string, (Artifact & { dir?: string })[]>;
  prs?: Record<string, { number: number; headRefName: string; headRefOid: string; url: string }>;
  fail?: Record<string, { code?: number; stderr: string }>;
}

/** Writes the data the stand-in gh serves; returns the environment that enables it and its call log. */
function fakeGh(data: FakeData) {
  const file = path.join(tempDir(), 'gh.json');
  writeFileSync(file, JSON.stringify(data));
  return {
    env: { REBASELINE_GH: fakeGhScript, FAKE_GH: file, GH_REPO: '' },
    calls: (): string[][] =>
      existsSync(`${file}.calls`)
        ? readFileSync(`${file}.calls`, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as string[])
        : [],
  };
}

function run(id: number, minutesAgo: number, fields: Partial<Run> = {}): Run {
  return {
    databaseId: id,
    attempt: 1,
    status: 'completed',
    conclusion: 'failure',
    headSha: '0000000000000000000000000000000000000000',
    headBranch: 'main',
    event: 'push',
    workflowName: 'tests',
    displayTitle: 'Update styles',
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    url: `https://github.com/acme/shop/actions/runs/${id}`,
    ...fields,
  };
}

function artifact(name: string, dir?: string, fields: Partial<Artifact> = {}): Artifact & { dir?: string } {
  return { id: 1, name, size_in_bytes: 2_500_000, expired: false, created_at: '2026-10-21T10:00:00Z', dir, ...fields };
}

/** The fixture repository with an origin remote on GitHub. */
async function makeGitHubRepo() {
  const repo = await makeRepo();
  await runGit(['remote', 'add', 'origin', 'https://github.com/acme/shop.git'], repo.root);
  return repo;
}

describe('rebaseline pull', () => {
  isolateGit();

  it('reviews the newest run of the branch that has a report and removes the download', async () => {
    const { project, head } = await makeGitHubRepo();
    const gh = fakeGh({
      runs: [
        run(4, 1, { status: 'in_progress', conclusion: '', headSha: head }),
        run(3, 5, { workflowName: 'lint', headSha: head }),
        run(2, 10, { headSha: head }),
        run(1, 60, { headSha: head }),
      ],
      artifacts: { '3': [], '2': [artifact('playwright-report', savedReport)], '1': [artifact('playwright-report', savedReport)] },
    });

    const cli = runCli(['pull', '--no-open'], project, gh.env);
    const page = await connect(cli);
    expect(page.state.shots).toHaveLength(8);
    expect((await page.accept(page.find('default', 'changed screenshot'))).status).toBe(200);
    await page.done();

    expect(await cli.exit).toBe(0);
    const { stdout } = cli.output();
    expect(stdout).toContain('Run 2: "tests" on main (failed, 10 minutes ago)');
    expect(stdout).toContain('https://github.com/acme/shop/actions/runs/2');
    expect(stdout).toContain('A newer run of "tests" has not finished yet.');
    expect(stdout).toContain('Downloaded playwright-report (2.4 MB).');
    expect(stdout).not.toContain('The run tested commit');
    expect(stdout).toContain(' M fixtures/pw-project/tests/visual.spec.ts-snapshots/hero-default-win32.png');

    const calls = gh.calls();
    expect(calls[0]).toEqual(['run', 'list', '-R', 'acme/shop', '--branch', 'main', '--limit', '20', '--json', expect.any(String)]);
    const download = calls.find((c) => c[0] === 'run' && c[1] === 'download') ?? [];
    expect(download.slice(0, 7)).toEqual(['run', 'download', '2', '-R', 'acme/shop', '-n', 'playwright-report']);
    expect(existsSync(path.dirname(download[8] ?? ''))).toBe(false);
  });

  it('stops when the newest run passed', async () => {
    const { project, head } = await makeGitHubRepo();
    const gh = fakeGh({ runs: [run(2, 3, { conclusion: 'success', headSha: head })], artifacts: { '2': [artifact('playwright-report', savedReport)] } });
    const cli = runCli(['pull', '--no-open'], project, gh.env);
    expect(await cli.exit).toBe(0);
    expect(cli.output().stdout).toContain('The run passed. Nothing to review.');
    expect(gh.calls().some((c) => c[1] === 'download')).toBe(false);
  });

  it('uses the newest run of a pull request and warns about a different commit', async () => {
    const { project } = await makeGitHubRepo();
    const sha = 'abc1234def5678abc1234def5678abc1234def56';
    const gh = fakeGh({
      prs: { '7': { number: 7, headRefName: 'feature', headRefOid: sha, url: 'https://github.com/acme/shop/pull/7' } },
      runs: [run(5, 2, { headSha: sha, headBranch: 'feature', event: 'pull_request' })],
      artifacts: { '5': [artifact('playwright-report', savedReport)] },
    });
    const cli = runCli(['pull', '--pr', '7', '--no-open'], project, gh.env);
    const page = await connect(cli);
    await page.done();

    expect(await cli.exit).toBe(0);
    expect(cli.output().stdout).toMatch(/The run tested commit abc1234, but your checkout is at [0-9a-f]{7}\./);
    const calls = gh.calls();
    expect(calls[0]).toEqual(['pr', 'view', '7', '-R', 'acme/shop', '--json', 'number,headRefName,headRefOid,url']);
    expect(calls[1]?.slice(0, 6)).toEqual(['run', 'list', '-R', 'acme/shop', '--commit', sha]);
  });

  it('joins the reports of a sharded run', async () => {
    const { project, head } = await makeGitHubRepo();
    // Both shards use the same test ids, as separate Playwright runs can.
    const shard = (seed: string) =>
      writeReport(path.join(tempDir(), 'report'), [
        { title: `card ${seed}`, results: [{ attachments: [{ name: 'card-actual.png', content: png(seed) }, { name: 'card-expected.png', content: png(`old ${seed}`) }] }] },
      ]);
    const gh = fakeGh({
      runs: [run(9, 30, { headSha: head })],
      artifacts: { '9': [artifact('playwright-report-2', shard('two')), artifact('playwright-report-1', shard('one')), artifact('coverage')] },
    });
    const cli = runCli(['pull', '--run', 'https://github.com/acme/shop/actions/runs/9', '--no-open'], project, gh.env);
    const page = await connect(cli);
    expect(page.state.shots.map((s) => s.title).sort()).toEqual(['card one', 'card two']);
    expect(new Set(page.state.shots.map((s) => s.id)).size).toBe(2);
    await page.done();

    expect(await cli.exit).toBe(0);
    expect(cli.output().stdout).toContain('Downloaded 2 report artifacts (4.8 MB).');
    expect(cli.output().stdout).not.toContain('The link points to');
  });

  it('explains when gh is not signed in', async () => {
    const { project } = await makeGitHubRepo();
    const gh = fakeGh({ fail: { 'run list': { code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' } } });
    const cli = runCli(['pull'], project, gh.env);
    expect(await cli.exit).toBe(1);
    expect(cli.output().stderr).toMatch(/^x The GitHub CLI \(gh\) is not signed in\n {2}Run "gh auth login"/);
  });

  it('explains a repository the account cannot see', async () => {
    const { project } = await makeGitHubRepo();
    const gh = fakeGh({ fail: { 'run list': { stderr: 'failed to get runs: HTTP 404: Not Found (https://api.github.com/repos/acme/shop/actions/runs)' } } });
    const cli = runCli(['pull'], project, gh.env);
    expect(await cli.exit).toBe(1);
    const { stderr } = cli.output();
    expect(stderr).toContain('acme/shop was not found, or the current GitHub account cannot see it');
    expect(stderr).toContain('GH_TOKEN');
  });

  it('shows the workflow step to add when no run uploaded a report', async () => {
    const { project } = await makeGitHubRepo();
    const gh = fakeGh({ runs: [run(2, 3)], artifacts: { '2': [artifact('coverage')] } });
    const cli = runCli(['pull'], project, gh.env);
    expect(await cli.exit).toBe(1);
    const { stderr } = cli.output();
    expect(stderr).toContain('No recent run for branch main uploaded a Playwright report');
    expect(stderr).toContain('- uses: actions/upload-artifact@v7');
    expect(stderr).toContain('name: playwright-report');
  });

  it('shows the merge job for blob reports', async () => {
    const { project } = await makeGitHubRepo();
    const gh = fakeGh({ runs: [run(2, 3)], artifacts: { '2': [artifact('blob-report-1'), artifact('blob-report-2')] } });
    const cli = runCli(['pull', '--run', '2'], project, gh.env);
    expect(await cli.exit).toBe(1);
    expect(cli.output().stderr).toContain('Run 2 uploaded blob reports, not an HTML report');
    expect(cli.output().stderr).toContain('npx playwright merge-reports --reporter html ./all-blob-reports');
  });

  it('explains an expired report', async () => {
    const { project } = await makeGitHubRepo();
    const gh = fakeGh({ runs: [run(2, 3)], artifacts: { '2': [artifact('playwright-report', undefined, { expired: true })] } });
    const cli = runCli(['pull', '--run', '2'], project, gh.env);
    expect(await cli.exit).toBe(1);
    expect(cli.output().stderr).toContain('The report of run 2 has expired');
    expect(gh.calls().some((c) => c[1] === 'download')).toBe(false);
  });

  it('lists the artifacts when the given name matches none', async () => {
    const { project } = await makeGitHubRepo();
    const gh = fakeGh({ runs: [run(2, 3)], artifacts: { '2': [artifact('playwright-report'), artifact('coverage')] } });
    const cli = runCli(['pull', '--run', '2', '--artifact', 'e2e-report'], project, gh.env);
    expect(await cli.exit).toBe(1);
    expect(cli.output().stderr).toContain('Run 2 has no artifact named e2e-report\n  Its artifacts: coverage, playwright-report.');
  });

  it('accepts numeric artifact and repository names', async () => {
    const { project } = await makeGitHubRepo();
    const gh = fakeGh({ runs: [run(2, 3)], artifacts: { '2': [artifact('playwright-report')] } });
    const cli = runCli(['pull', '--run', '2', '--artifact', '1', '--repo', '123'], project, gh.env);
    expect(await cli.exit).toBe(1);
    expect(cli.output().stderr).toContain('Invalid --repo: 123');
    const named = runCli(['pull', '--run', '2', '--artifact', '1'], project, gh.env);
    expect(await named.exit).toBe(1);
    expect(named.output().stderr).toContain('Run 2 has no artifact named 1');
  });

  it('explains an artifact without a report and removes the download', async () => {
    const { project } = await makeGitHubRepo();
    const notes = tempDir();
    writeFiles(notes, { 'notes.txt': 'hello' });
    const gh = fakeGh({ runs: [run(2, 3)], artifacts: { '2': [artifact('playwright-report', notes)] } });
    const cli = runCli(['pull', '--run', '2'], project, gh.env);
    expect(await cli.exit).toBe(1);
    expect(cli.output().stderr).toContain('The artifact playwright-report does not contain a Playwright HTML report');
    const download = gh.calls().find((c) => c[1] === 'download') ?? [];
    expect(existsSync(path.dirname(download[8] ?? ''))).toBe(false);
  });

  it('waits for a run that has not finished', async () => {
    const { project } = await makeGitHubRepo();
    const gh = fakeGh({ runs: [run(2, 1, { status: 'in_progress', conclusion: '' })] });
    const cli = runCli(['pull', '--run', '2'], project, gh.env);
    expect(await cli.exit).toBe(1);
    expect(cli.output().stderr).toContain('Run 2 has not finished yet');
  });

  it('refuses --run together with --pr', async () => {
    const { project } = await makeGitHubRepo();
    const cli = runCli(['pull', '--run', '2', '--pr', '7'], project, fakeGh({}).env);
    expect(await cli.exit).toBe(1);
    expect(cli.output().stderr).toContain('Use --run or --pr, not both');
  });
});

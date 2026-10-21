import { type ChildProcess, spawn } from 'node:child_process';
import { cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runGit } from '../src/core/git.js';
import type { StateView } from '../src/review/view.js';
import { fixtureDir, isolateGit, tempDir, writeReport } from './helpers.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

/** A git repository holding the fixture baselines at fixtures/pw-project, committed. */
async function makeRepo(): Promise<{ root: string; project: string }> {
  const root = tempDir();
  const project = path.join(root, 'fixtures', 'pw-project');
  cpSync(path.join(fixtureDir, 'baselines'), project, { recursive: true });
  await runGit(['init', '-q'], root);
  await runGit(['add', '.'], root);
  await runGit(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init'], root);
  return { root, project };
}

function runCli(args: string[], cwd: string) {
  const child = spawn(process.execPath, [cliPath, ...args], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  const exit = new Promise<number | null>((resolve) => child.on('exit', resolve));
  const waitFor = async (re: RegExp): Promise<RegExpMatchArray> => {
    for (let i = 0; i < 300; i++) {
      const m = stdout.match(re);
      if (m) return m;
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Output did not match ${re}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  };
  return { exit, waitFor, output: () => ({ stdout, stderr }) };
}

describe('rebaseline review', () => {
  isolateGit();

  it('writes exactly the accepted screenshots and prints a summary', async () => {
    const { root, project } = await makeRepo();
    const reportDir = path.join(tempDir(), 'report');
    cpSync(path.join(fixtureDir, 'report'), reportDir, { recursive: true });

    const cli = runCli(['review', '--report', reportDir, '--no-open'], project);
    const [, url = ''] = await cli.waitFor(/Review page: (http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/);
    const { origin, searchParams } = new URL(url);
    const headers = { 'x-rebaseline-token': searchParams.get('token') ?? '' };

    const state = (await (await fetch(`${origin}/api/state`, { headers })).json()) as StateView;
    expect(state.shots).toHaveLength(8);
    expect(state.others).toHaveLength(2);
    expect(state.shots.every((s) => s.unresolved === null)).toBe(true);

    const pick = (project: string, title: string) => state.shots.find((s) => s.project === project && s.title === title)?.id ?? '';
    for (const id of [pick('default', 'changed screenshot'), pick('custom', 'changed screenshot'), pick('custom', 'new screenshot')]) {
      const res = await fetch(`${origin}/api/shots/${encodeURIComponent(id)}/accept`, { method: 'POST', headers });
      expect(res.status).toBe(200);
    }
    await fetch(`${origin}/api/done`, { method: 'POST', headers });

    expect(await cli.exit).toBe(0);
    const { stdout } = cli.output();
    expect(stdout).toContain('Review finished: 3 accepted, 0 rejected, 5 not reviewed.');
    expect(stdout).toContain(' M fixtures/pw-project/tests/visual.spec.ts-snapshots/hero-default-win32.png');
    expect(stdout).toContain(' M fixtures/pw-project/tests/__screenshots__/custom/visual.spec.ts/hero.png');
    expect(stdout).toContain('?? fixtures/pw-project/tests/__screenshots__/custom/visual.spec.ts/brand-new.png');

    const status = await runGit(['status', '--porcelain', '--untracked-files=all'], root);
    expect(status.trimEnd().split('\n').sort()).toEqual([
      ' M fixtures/pw-project/tests/__screenshots__/custom/visual.spec.ts/hero.png',
      ' M fixtures/pw-project/tests/visual.spec.ts-snapshots/hero-default-win32.png',
      '?? fixtures/pw-project/tests/__screenshots__/custom/visual.spec.ts/brand-new.png',
    ]);
  });

  it('says there is nothing to review when every test passed', async () => {
    const { project } = await makeRepo();
    const reportDir = writeReport(tempDir(), [{ title: 'ok', outcome: 'expected', results: [{ status: 'passed' }] }]);
    const cli = runCli(['review', '--report', reportDir, '--no-open'], project);
    expect(await cli.exit).toBe(0);
    expect(cli.output().stdout).toContain('No failed tests');
  });

  it('lists failures that are not screenshots without opening a page', async () => {
    const { project } = await makeRepo();
    const reportDir = writeReport(tempDir(), [{ title: 'text check', results: [{ errors: ['Error: boom'] }] }]);
    const cli = runCli(['review', '--report', reportDir, '--no-open'], project);
    expect(await cli.exit).toBe(0);
    const { stdout } = cli.output();
    expect(stdout).toContain('1 test failed');
    expect(stdout).toContain('text check');
    expect(stdout).not.toContain('Review page');
  });

  it('explains a missing report in two lines', async () => {
    const { project } = await makeRepo();
    const cli = runCli(['review', '--report', 'nope', '--no-open'], project);
    expect(await cli.exit).toBe(1);
    expect(cli.output().stderr).toMatch(/^x No Playwright HTML report found in nope\n  Run your tests with the HTML reporter first/);
  });

  it('rejects an invalid port', async () => {
    const { project } = await makeRepo();
    const cli = runCli(['review', '--port', 'abc'], project);
    expect(await cli.exit).toBe(1);
    expect(cli.output().stderr).toContain('Invalid --port: abc');
  });
});

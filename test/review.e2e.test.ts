import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGit } from '../src/core/git.js';
import type { StateView } from '../src/review/view.js';
import { connect, makeRepo, runCli } from './e2e-helpers.js';
import { fixtureDir, installFakePlaywright, isolateGit, lfsPointer, tempDir, writeFiles, writeReport } from './helpers.js';

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
    // Relative to the folder rebaseline ran in, ready to copy.
    const add = stdout.split('\n').find((line) => line.trim().startsWith('git add -- '))?.trim().split(' ').slice(3).sort();
    expect(add).toEqual([
      'tests/__screenshots__/custom/visual.spec.ts/brand-new.png',
      'tests/__screenshots__/custom/visual.spec.ts/hero.png',
      'tests/visual.spec.ts-snapshots/hero-default-win32.png',
    ]);

    const status = await runGit(['status', '--porcelain', '--untracked-files=all'], root);
    expect(status.trimEnd().split('\n').sort()).toEqual([
      ' M fixtures/pw-project/tests/__screenshots__/custom/visual.spec.ts/hero.png',
      ' M fixtures/pw-project/tests/visual.spec.ts-snapshots/hero-default-win32.png',
      '?? fixtures/pw-project/tests/__screenshots__/custom/visual.spec.ts/brand-new.png',
    ]);
  });

  it('replaces a Git LFS pointer with the accepted image, and puts the pointer back on reject', async () => {
    const { root, project } = await makeRepo();
    // The repository keeps this baseline in Git LFS and the image was never downloaded.
    const rel = 'tests/visual.spec.ts-snapshots/hero-default-win32.png';
    const file = path.join(project, rel);
    const pointer = lfsPointer(readFileSync(file));
    writeFileSync(file, pointer);
    await runGit(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-am', 'lfs'], root);
    const reportDir = path.join(tempDir(), 'report');
    cpSync(path.join(fixtureDir, 'report'), reportDir, { recursive: true });

    const cli = runCli(['review', '--report', reportDir, '--no-open'], project);
    const page = await connect(cli);
    const shot = page.state.shots.find((s) => s.project === 'default' && s.title === 'changed screenshot');
    expect(shot).toMatchObject({ via: 'lfs', target: `fixtures/pw-project/${rel}` });

    expect((await page.accept(shot?.id ?? '')).status).toBe(200);
    expect(readFileSync(file).subarray(1, 4).toString()).toBe('PNG');
    expect((await page.reject(shot?.id ?? '')).status).toBe(200);
    expect(readFileSync(file, 'utf8')).toBe(pointer);
    expect((await page.accept(shot?.id ?? '')).status).toBe(200);
    await page.done();

    expect(await cli.exit).toBe(0);
    expect(cli.output().stdout).toContain(` M fixtures/pw-project/${rel}`);
  });

  it('serves the page with its logo and the favicons', async () => {
    const { project } = await makeRepo();
    const reportDir = path.join(tempDir(), 'report');
    cpSync(path.join(fixtureDir, 'report'), reportDir, { recursive: true });
    const cli = runCli(['review', '--report', reportDir, '--no-open'], project);
    const [, url = ''] = await cli.waitFor(/Review page: (http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/);
    const { origin } = new URL(url);

    const page = await (await fetch(url)).text();
    expect(page).toMatch(/<template id="logo"><svg [^>]*viewBox="0 0 256 256"/);
    expect(page).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    // The links under the help and the end message; the page address, with its token, is never sent to them.
    expect(page).toContain('https://github.com/theghost1980/rebaseline/discussions/13');
    expect(page).toContain('https://www.npmjs.com/package/rebaseline');
    expect(page).toContain('https://github.com/theghost1980/');
    expect(page).toContain('noopener noreferrer');
    expect(await (await fetch(`${origin}/favicon.svg`)).text()).toContain('class="rb-accent"');
    // ICO files start with 00 00 01 00, then the number of images.
    expect([...Buffer.from(await (await fetch(`${origin}/favicon.ico`)).arrayBuffer()).subarray(0, 6)]).toEqual([0, 0, 1, 0, 2, 0]);

    const { searchParams } = new URL(url);
    await fetch(`${origin}/api/done`, { method: 'POST', headers: { 'x-rebaseline-token': searchParams.get('token') ?? '' } });
    expect(await cli.exit).toBe(0);
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
    expect(stdout).toContain(', not on a screenshot.');
    expect(stdout).toContain('[chromium] text check');
    expect(stdout).not.toContain('Review page');
  });

  it('leaves out the project of a config without projects', async () => {
    const { project } = await makeRepo();
    const reportDir = writeReport(tempDir(), [
      { title: 'text check', projectName: '', results: [{ errors: ['Error: boom'] }] },
      { title: 'other check', projectName: '', results: [{ errors: ['Error: boom'] }] },
    ]);
    const cli = runCli(['review', '--report', reportDir, '--no-open'], project);
    expect(await cli.exit).toBe(0);
    const { stdout } = cli.output();
    expect(stdout).toContain(', none of them on a screenshot.');
    expect(stdout).toMatch(/ text check \(example\.spec\.ts:1\)/);
    expect(stdout).not.toContain('[]');
  });

  it('points to the project folder when the baselines are outside the current folder', async () => {
    const { root, project } = await makeRepo();
    writeFiles(project, { 'playwright.config.ts': 'export default {};' });
    const elsewhere = path.join(root, 'docs');
    mkdirSync(elsewhere);
    const reportDir = path.join(tempDir(), 'report');
    cpSync(path.join(fixtureDir, 'report'), reportDir, { recursive: true });

    const cli = runCli(['review', '--report', reportDir, '--no-open'], elsewhere);
    const page = await connect(cli);
    await page.done();

    expect(await cli.exit).toBe(0);
    const { stdout } = cli.output();
    expect(stdout).toContain(`The baselines of the changed screenshots are outside this folder, in ${project}.`);
    expect(stdout).toContain(`Run rebaseline from there: cd ${path.join('..', 'fixtures', 'pw-project')}`);
  });

  it('points to the project of a local report when the baselines are also copied elsewhere', async () => {
    const { root, project } = await makeRepo();
    cpSync(path.join(fixtureDir, 'baselines'), path.join(root, 'archive'), { recursive: true });
    await runGit(['add', '.'], root);
    await runGit(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'copy'], root);
    const reportDir = path.join(project, 'playwright-report');
    cpSync(path.join(fixtureDir, 'report'), reportDir, { recursive: true });
    const elsewhere = path.join(root, 'docs');
    mkdirSync(elsewhere);

    const cli = runCli(['review', '--report', reportDir, '--no-open'], elsewhere);
    const page = await connect(cli);
    await page.done();

    expect(await cli.exit).toBe(0);
    expect(cli.output().stdout).toContain(`Run rebaseline from there: cd ${path.join('..', 'fixtures', 'pw-project')}`);
  });

  it('stops when the report comes from another repository', async () => {
    const { project } = await makeRepo();
    const reportDir = path.join(project, 'playwright-report');
    cpSync(path.join(fixtureDir, 'report'), reportDir, { recursive: true });
    const other = tempDir();
    await runGit(['init', '-q'], other);

    const cli = runCli(['review', '--report', reportDir, '--no-open'], other);
    expect(await cli.exit).toBe(1);
    const { stdout, stderr } = cli.output();
    expect(stderr).toContain(`The report comes from another repository: ${project}\n  Run rebaseline from there: cd ${path.relative(other, project)}`);
    expect(stdout).not.toContain('Review page');
  });

  it('suggests the project folder when the current folder is not in a repository', async () => {
    const { project } = await makeRepo();
    const reportDir = path.join(project, 'playwright-report');
    cpSync(path.join(fixtureDir, 'report'), reportDir, { recursive: true });
    const outside = tempDir();

    const cli = runCli(['review', '--report', reportDir, '--no-open'], outside);
    expect(await cli.exit).toBe(1);
    expect(cli.output().stderr).toContain(`is not inside a git repository\n  Run rebaseline from the project folder: cd ${path.relative(outside, project)}`);
  });

  it('explains a missing report in two lines', async () => {
    const { project } = await makeRepo();
    const cli = runCli(['review', '--report', 'nope', '--no-open'], project);
    expect(await cli.exit).toBe(1);
    expect(cli.output().stderr).toMatch(/^x No Playwright HTML report found in nope\n  Run your tests with the HTML reporter first/);
  });

  it('accepts a report folder with a numeric name', async () => {
    const { project } = await makeRepo();
    const cli = runCli(['review', '--report', '2024', '--no-open'], project);
    expect(await cli.exit).toBe(1);
    expect(cli.output().stderr).toContain('No Playwright HTML report found in 2024');
  });

  it('rejects an invalid port', async () => {
    const { project } = await makeRepo();
    const cli = runCli(['review', '--port', 'abc'], project);
    expect(await cli.exit).toBe(1);
    expect(cli.output().stderr).toContain('Invalid --port: abc');
  });

  it('lists a rejected new screenshot left on disk without deleting it', async () => {
    const { root, project } = await makeRepo();
    const reportDir = path.join(tempDir(), 'report');
    cpSync(path.join(fixtureDir, 'report'), reportDir, { recursive: true });
    const target = 'fixtures/pw-project/tests/__screenshots__/custom/visual.spec.ts/brand-new.png';

    const cli = runCli(['review', '--report', reportDir, '--no-open'], project);
    const page = await connect(cli);
    const id = page.find('custom', 'new screenshot');
    expect((await page.accept(id)).status).toBe(200);
    expect((await page.reject(id)).status).toBe(200);
    await page.done();

    expect(await cli.exit).toBe(0);
    const { stdout } = cli.output();
    expect(stdout).toContain('A new screenshot you rejected is still on disk, not tracked by git:');
    expect(stdout).toContain(target);
    expect(stdout).toContain('Delete them yourself if you do not want them.');
    expect(existsSync(path.join(root, target))).toBe(true);
  });

  it('warns about new screenshots that Playwright did not save', async () => {
    const { project } = await makeRepo();
    const reportDir = writeReport(tempDir(), [
      { title: 'fresh', results: [{ errors: ["Error: A snapshot doesn't exist at /home/runner/work/a/a/shots/fresh.png."] }] },
    ]);
    const cli = runCli(['review', '--report', reportDir, '--no-open'], project);
    expect(await cli.exit).toBe(0);
    expect(cli.output().stdout).toContain('1 new screenshot reported by Playwright was not saved');
    expect(cli.output().stdout).toContain('--update-snapshots=none');
  });

  it('refuses arguments after -- without --run', async () => {
    const { project } = await makeRepo();
    const cli = runCli(['review', '--no-open', '--', '--project=chromium'], project);
    expect(await cli.exit).toBe(1);
    expect(cli.output().stderr).toContain('only used with --run');
  });

  it('runs the project Playwright with --run and reviews its report', async () => {
    const { project } = await makeRepo();
    // Stand-in runner: records how it was called and "produces" the saved report.
    installFakePlaywright(
      project,
      `const fs = require('fs');
       fs.writeFileSync('run-call.json', JSON.stringify({ args: process.argv.slice(2), out: process.env.PLAYWRIGHT_HTML_OUTPUT_DIR, open: process.env.PLAYWRIGHT_HTML_OPEN }));
       fs.cpSync(process.env.FAKE_REPORT, process.env.PLAYWRIGHT_HTML_OUTPUT_DIR, { recursive: true });
       process.exit(1);`,
    );
    const cli = runCli(['review', '--run', '--no-open', '--', '--project=custom'], project, { FAKE_REPORT: path.join(fixtureDir, 'report') });
    const page = await connect(cli);
    expect(page.state.shots).toHaveLength(8);
    await page.done();

    expect(await cli.exit).toBe(0);
    expect(cli.output().stdout).toContain('Running Playwright: playwright test --reporter=html,list --project=custom');
    const call = JSON.parse(readFileSync(path.join(project, 'run-call.json'), 'utf8')) as { args: string[]; out: string; open: string };
    expect(call).toEqual({ args: ['test', '--reporter=html,list', '--project=custom'], out: path.join(project, 'playwright-report'), open: 'never' });
  });

  it('explains when --run cannot find Playwright', async () => {
    const { project } = await makeRepo();
    const cli = runCli(['review', '--run', '--no-open'], project);
    expect(await cli.exit).toBe(1);
    expect(cli.output().stderr).toContain('@playwright/test is not installed');
  });
});

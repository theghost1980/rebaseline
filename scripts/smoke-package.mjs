// Checks the package the way a user gets it:
//
//   1. packs it with npm pack, as npm publish would,
//   2. installs the tarball in an empty folder (offline: it has no dependencies),
//   3. runs the installed command, and reviews the saved Playwright report in a
//      new git repository with the saved baselines: accepts one screenshot and
//      checks that git sees exactly that file changed.
//
// Needs git and a built dist/ (npm run build). CI runs it on every system and on
// the oldest Node.js the package supports. Everything happens in a temporary
// folder that is removed at the end.

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const fixture = path.join(repo, 'fixtures', 'reports', 'pw-1.64.1-win32');
const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rebaseline-smoke-')));

/** Runs a command through the shell (npm and npx are .cmd files on Windows). */
function sh(command, cwd) {
  return execSync(command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function check(ok, message) {
  if (!ok) throw new Error(message);
  console.log(`ok - ${message}`);
}

async function review(cli, cwd, reportDir) {
  const child = spawn(process.execPath, [cli, 'review', '--report', reportDir, '--no-open'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
  child.stderr.setEncoding('utf8').on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    let url = null;
    for (let i = 0; i < 600 && !url && child.exitCode === null; i++) {
      url = /Review page: (http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/.exec(out)?.[1] ?? null;
      if (!url) await new Promise((r) => setTimeout(r, 100));
    }
    if (!url) throw new Error(`The review page did not start:\n${out}`);
    const { origin, searchParams } = new URL(url);
    const headers = { 'x-rebaseline-token': searchParams.get('token') ?? '' };
    const state = await (await fetch(`${origin}/api/state`, { headers })).json();
    check(state.shots.length === 8, 'the review page lists the 8 failed screenshots');
    const shot = state.shots.find((s) => s.project === 'default' && s.title === 'changed screenshot');
    const accepted = await fetch(`${origin}/api/shots/${encodeURIComponent(shot?.id ?? '')}/accept`, { method: 'POST', headers });
    check(accepted.status === 200, 'accepting a screenshot works');
    await fetch(`${origin}/api/done`, { method: 'POST', headers });
    const code = await exited;
    check(code === 0, 'the review ends cleanly after Done');
    return out;
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

try {
  console.log(`Node.js ${process.versions.node}, ${process.platform}`);

  const [packed] = JSON.parse(sh(`npm pack --json --pack-destination "${work}"`, repo));
  const files = packed.files.map((f) => f.path).sort();
  check(['LICENSE', 'README.md', 'dist/cli.js', 'package.json'].every((f) => files.includes(f)), `the tarball has the CLI, README and LICENSE (${files.join(', ')})`);

  const app = path.join(work, 'app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'package.json'), '{ "name": "smoke", "private": true }\n');
  sh(`npm install --offline --no-audit --no-fund "${path.join(work, packed.filename)}"`, app);
  check(sh('npx --offline rebaseline --version', app).includes(version), `the installed command prints version ${version}`);
  check(sh('npx --offline rebaseline --help', app).includes('pull'), 'the installed command prints its help');

  const root = path.join(work, 'repo');
  const project = path.join(root, 'fixtures', 'pw-project');
  fs.cpSync(path.join(fixture, 'baselines'), project, { recursive: true });
  sh('git init -q -b main', root);
  sh('git add .', root);
  sh('git -c user.name=smoke -c user.email=smoke@example.com commit -q -m baselines', root);
  const reportDir = path.join(work, 'report');
  fs.cpSync(path.join(fixture, 'report'), reportDir, { recursive: true });

  const out = await review(path.join(app, 'node_modules', 'rebaseline', 'dist', 'cli.js'), project, reportDir);
  check(out.includes('Review finished: 1 accepted'), 'the summary counts the accepted screenshot');
  const status = sh('git status --porcelain --untracked-files=all', root).trim();
  check(status === 'M fixtures/pw-project/tests/visual.spec.ts-snapshots/hero-default-win32.png', 'git sees exactly the accepted file changed');
} catch (err) {
  console.error(`not ok - ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 });
}

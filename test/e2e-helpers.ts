import { type ChildProcess, spawn } from 'node:child_process';
import { cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { runGit } from '../src/core/git.js';
import type { StateView } from '../src/review/view.js';
import { fixtureDir, tempDir } from './helpers.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

/** A git repository on branch main holding the fixture baselines at fixtures/pw-project, committed. */
export async function makeRepo(): Promise<{ root: string; project: string; head: string }> {
  const root = tempDir();
  const project = path.join(root, 'fixtures', 'pw-project');
  cpSync(path.join(fixtureDir, 'baselines'), project, { recursive: true });
  await runGit(['init', '-q', '-b', 'main'], root);
  await runGit(['add', '.'], root);
  await runGit(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init'], root);
  const head = (await runGit(['rev-parse', 'HEAD'], root)).trim();
  return { root, project, head };
}

/** Starts the compiled CLI. */
export function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [cliPath, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  return { exit, waitFor, output: () => ({ stdout, stderr }), kill: (signal: NodeJS.Signals) => child.kill(signal) };
}

/** Talks to a running review through its API, like the page does. */
export async function connect(cli: ReturnType<typeof runCli>) {
  const [, url = ''] = await cli.waitFor(/Review page: (http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/);
  const { origin, searchParams } = new URL(url);
  const headers = { 'x-rebaseline-token': searchParams.get('token') ?? '' };
  const state = (await (await fetch(`${origin}/api/state`, { headers })).json()) as StateView;
  const post = (route: string) => fetch(`${origin}${route}`, { method: 'POST', headers });
  const find = (project: string, title: string) => state.shots.find((s) => s.project === project && s.title === title)?.id ?? '';
  return {
    state,
    find,
    accept: (id: string) => post(`/api/shots/${encodeURIComponent(id)}/accept`),
    reject: (id: string) => post(`/api/shots/${encodeURIComponent(id)}/reject`),
    done: () => post('/api/done'),
  };
}

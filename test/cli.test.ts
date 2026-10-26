import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkNodeVersion } from '../src/lib/node-version.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function run(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd: root, encoding: 'utf8' });
}

describe('built cli', () => {
  it('prints the version', () => {
    const res = run(['--version']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(__VERSION__);
  });

  it('reports unknown commands in two plain lines without a stack trace', () => {
    const res = run(['nope']);
    expect(res.status).toBe(1);
    expect(res.stderr).toBe('x Unknown command: nope\n  Run "rebaseline --help" to see the available commands.\n');
  });

  it('reports unknown options without a stack trace', () => {
    const res = run(['--wat']);
    expect(res.status).toBe(1);
    expect(res.stderr).not.toContain('    at ');
  });

  it('shows the options in the usage line of each command', () => {
    expect(run(['pull', '--help']).stdout).toContain('$ rebaseline pull [options]');
    expect(run(['review', '--help']).stdout).toContain('$ rebaseline review [options]');
  });
});

describe('checkNodeVersion', () => {
  it('refuses Node.js versions older than 22', () => {
    expect(() => checkNodeVersion('20.19.0')).toThrow('rebaseline needs Node.js 22 or newer, and this is Node.js 20.19.0');
    expect(() => checkNodeVersion('22.0.0')).not.toThrow();
    expect(() => checkNodeVersion('24.12.0')).not.toThrow();
  });
});

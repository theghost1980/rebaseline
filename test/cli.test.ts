import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
});

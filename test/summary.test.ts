import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionResults } from '../src/review/session.js';
import { printSummary } from '../src/review/summary.js';
import { isolateGit, tempDir } from './helpers.js';

/** Collects what printSummary writes. */
function captureOutput(): () => string {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  return () => out;
}

function results(lfs: boolean): SessionResults {
  return { accepted: [{ target: 'shots/hero.png', kind: 'changed', untracked: false, lfs, created: false }], rejected: 0, pending: 0, rejectedNew: [] };
}

describe('printSummary', () => {
  isolateGit();
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns when accepted Git LFS files would be committed without git-lfs', async () => {
    const output = captureOutput();
    await printSummary(results(true), tempDir(), async () => false);
    expect(output()).toContain('1 accepted file is stored with Git LFS, but git-lfs is not installed.');
  });

  it('says nothing about Git LFS when git-lfs is installed or no LFS file was accepted', async () => {
    const check = vi.fn(async () => false);
    const output = captureOutput();
    await printSummary(results(true), tempDir(), async () => true);
    await printSummary(results(false), tempDir(), check);
    expect(output()).not.toContain('Git LFS');
    expect(check).not.toHaveBeenCalled();
  });
});

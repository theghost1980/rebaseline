import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runGit } from '../src/core/git.js';
import { findRemovable, offerCleanup } from '../src/review/cleanup.js';
import { isolateGit, png, sha1, tempDir, writeFiles } from './helpers.js';

async function makeRepo() {
  const root = tempDir();
  await runGit(['init', '-q'], root);
  writeFiles(root, {
    'shots/tracked.png': png('tracked'),
    'shots/staged.png': png('staged'),
    'shots/new.png': png('new'),
    'shots/edited.png': png('edited by hand'),
  });
  await runGit(['add', 'shots/tracked.png'], root);
  await runGit(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init'], root);
  await runGit(['add', 'shots/staged.png'], root);
  const rejected = [
    { target: 'shots/tracked.png', sha1: sha1(png('tracked')) },
    { target: 'shots/staged.png', sha1: sha1(png('staged')) },
    { target: 'shots/new.png', sha1: sha1(png('new')) },
    { target: 'shots/edited.png', sha1: sha1(png('edited')) },
    { target: 'shots/gone.png', sha1: sha1(png('gone')) },
    { target: '../outside.png', sha1: sha1(png('outside')) },
  ];
  return { root, rejected };
}

describe('cleanup of rejected new screenshots', () => {
  isolateGit();
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('only offers untracked, unstaged files that still hold the reported image', async () => {
    const { root, rejected } = await makeRepo();
    expect(await findRemovable(root, rejected)).toEqual([{ target: 'shots/new.png', sha1: sha1(png('new')) }]);
  });

  it('lists the files without deleting them when nobody can answer', async () => {
    const { root, rejected } = await makeRepo();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await offerCleanup(root, rejected);
    const printed = out.mock.calls.map((c) => String(c[0])).join('');
    out.mockRestore();
    expect(printed).toContain('shots/new.png');
    expect(printed).toContain('Delete them yourself');
    expect(existsSync(path.join(root, 'shots', 'new.png'))).toBe(true);
  });

  it('keeps the files when the answer is no', async () => {
    const { root, rejected } = await makeRepo();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const ask = vi.fn(async () => false);
    await offerCleanup(root, rejected, ask);
    expect(ask).toHaveBeenCalledWith('Delete this file?');
    expect(existsSync(path.join(root, 'shots', 'new.png'))).toBe(true);
  });

  it('deletes only the offered files when the answer is yes', async () => {
    const { root, rejected } = await makeRepo();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await offerCleanup(root, rejected, async () => true);
    expect(existsSync(path.join(root, 'shots', 'new.png'))).toBe(false);
    for (const kept of ['tracked', 'staged', 'edited']) expect(existsSync(path.join(root, 'shots', `${kept}.png`))).toBe(true);
  });

  it('asks nothing when there is nothing to delete', async () => {
    const { root } = await makeRepo();
    const ask = vi.fn(async () => true);
    await offerCleanup(root, [{ target: 'shots/tracked.png', sha1: sha1(png('tracked')) }], ask);
    expect(ask).not.toHaveBeenCalled();
  });
});

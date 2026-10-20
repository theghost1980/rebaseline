import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WriterError, checkTarget, restoreBaseline, writeBaseline } from '../src/core/writer.js';
import { png, tempDir, writeFiles } from './helpers.js';

function setup() {
  const base = tempDir();
  const root = path.join(base, 'repo');
  const source = path.join(base, 'report', 'data', 'new.png');
  writeFiles(base, { 'report/data/new.png': png('new look'), 'repo/README.md': 'x' });
  return { base, root, source };
}

async function rejection(promise: Promise<unknown>): Promise<WriterError> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WriterError);
  return err as WriterError;
}

describe('writeBaseline', () => {
  it('creates a new file and the folders it needs', async () => {
    const { root, source } = setup();
    const result = await writeBaseline(root, 'e2e/__screenshots__/chromium/home.spec.ts/hero.png', source);
    expect(result).toMatchObject({ target: 'e2e/__screenshots__/chromium/home.spec.ts/hero.png', created: true, previous: null });
    expect(readFileSync(result.file)).toEqual(png('new look'));
  });

  it('replaces an existing file and returns its previous content', async () => {
    const { root, source } = setup();
    writeFiles(root, { 'shots/hero.png': png('old look') });
    const result = await writeBaseline(root, 'shots/hero.png', source);
    expect(result.created).toBe(false);
    expect(result.previous).toEqual(png('old look'));
    expect(readFileSync(path.join(root, 'shots', 'hero.png'))).toEqual(png('new look'));
  });

  it('accepts Windows separators in the target', async () => {
    const { root, source } = setup();
    const result = await writeBaseline(root, 'shots\\win\\hero.png', source);
    expect(result.target).toBe('shots/win/hero.png');
    expect(existsSync(path.join(root, 'shots', 'win', 'hero.png'))).toBe(true);
  });

  it('leaves no temporary files behind', async () => {
    const { root, source } = setup();
    await writeBaseline(root, 'shots/hero.png', source);
    expect(readdirSync(path.join(root, 'shots'))).toEqual(['hero.png']);
  });

  it.each([
    ['a parent folder', '../outside.png'],
    ['a parent folder after a subfolder', 'shots/../../outside.png'],
    ['a parent folder with backslashes', '..\\outside.png'],
    ['an absolute POSIX path', '/tmp/outside.png'],
    ['an absolute Windows path', 'C:\\outside.png'],
    ['a drive-relative Windows path', 'C:outside.png'],
    ['a network path', '\\\\server\\share\\outside.png'],
    ['an empty path', ''],
    ['an empty segment', 'shots//hero.png'],
    ['a dot segment', './hero.png'],
    ['the .git folder', '.git/hero.png'],
    ['the .git folder in another case', 'sub/.GIT/hero.png'],
  ])('refuses %s', async (_name, target) => {
    const { base, root, source } = setup();
    const err = await rejection(writeBaseline(root, target, source));
    expect(['invalid-path', 'outside-repo']).toContain(err.code);
    expect(existsSync(path.join(base, 'outside.png'))).toBe(false);
  });

  it.each(['hero.jpg', 'hero.png.txt', 'hero', 'shots/hero.png/'])('refuses the non-PNG target %s', async (target) => {
    const { root, source } = setup();
    expect((await rejection(writeBaseline(root, target, source))).code).toMatch(/not-png|invalid-path/);
  });

  it('accepts an upper-case .PNG extension', async () => {
    const { root, source } = setup();
    await expect(writeBaseline(root, 'HERO.PNG', source)).resolves.toMatchObject({ target: 'HERO.PNG' });
  });

  it('refuses a target that is a folder', async () => {
    const { root, source } = setup();
    mkdirSync(path.join(root, 'odd.png'));
    expect((await rejection(writeBaseline(root, 'odd.png', source))).code).toBe('not-a-file');
  });

  it('refuses to write through a folder link that points outside the repository', async (ctx) => {
    const { base, root, source } = setup();
    mkdirSync(path.join(base, 'outside'));
    try {
      symlinkSync(path.join(base, 'outside'), path.join(root, 'linked'), 'junction');
    } catch {
      ctx.skip();
    }
    expect((await rejection(writeBaseline(root, 'linked/hero.png', source))).code).toBe('outside-repo');
    expect((await rejection(writeBaseline(root, 'linked/deeper/hero.png', source))).code).toBe('outside-repo');
    expect(readdirSync(path.join(base, 'outside'))).toEqual([]);
  });

  it('refuses to write through a file link', async (ctx) => {
    const { base, root, source } = setup();
    writeFiles(base, { 'outside.png': png('outside') });
    try {
      symlinkSync(path.join(base, 'outside.png'), path.join(root, 'hero.png'), 'file');
    } catch {
      ctx.skip(); // Windows needs Developer Mode or admin rights for file links.
    }
    expect((await rejection(writeBaseline(root, 'hero.png', source))).code).toBe('outside-repo');
    expect(readFileSync(path.join(base, 'outside.png'))).toEqual(png('outside'));
  });

  it('refuses a source that is not a PNG image and keeps the existing file', async () => {
    const { base, root } = setup();
    writeFiles(base, { 'not-an-image.png': 'hello' });
    writeFiles(root, { 'hero.png': png('old look') });
    expect((await rejection(writeBaseline(root, 'hero.png', path.join(base, 'not-an-image.png')))).code).toBe('bad-source');
    expect(readFileSync(path.join(root, 'hero.png'))).toEqual(png('old look'));
  });

  it('refuses a missing source', async () => {
    const { base, root } = setup();
    expect((await rejection(writeBaseline(root, 'hero.png', path.join(base, 'nope.png')))).code).toBe('bad-source');
    expect(existsSync(path.join(root, 'hero.png'))).toBe(false);
  });
});

describe('restoreBaseline', () => {
  it('puts the previous content back', async () => {
    const { root, source } = setup();
    writeFiles(root, { 'shots/hero.png': png('old look') });
    const { previous } = await writeBaseline(root, 'shots/hero.png', source);
    await restoreBaseline(root, 'shots/hero.png', previous as Buffer);
    expect(readFileSync(path.join(root, 'shots', 'hero.png'))).toEqual(png('old look'));
  });

  it('applies the same checks as writing', async () => {
    const { root } = setup();
    expect((await rejection(restoreBaseline(root, '../hero.png', png('x')))).code).toBe('invalid-path');
    expect((await rejection(restoreBaseline(root, 'hero.png', Buffer.from('not a png')))).code).toBe('bad-source');
  });
});

describe('checkTarget', () => {
  it('returns the absolute path and the normalized target', async () => {
    const { root } = setup();
    await expect(checkTarget(root, 'a\\b\\c.png')).resolves.toEqual({ file: path.join(root, 'a', 'b', 'c.png'), rel: 'a/b/c.png' });
  });
});

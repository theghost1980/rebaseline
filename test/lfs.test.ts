import { describe, expect, it } from 'vitest';
import { lfsPointerOid } from '../src/core/lfs.js';
import { indexFiles } from '../src/core/resolver.js';
import { lfsPointer, png, sha1, sha256, tempDir, writeFiles } from './helpers.js';

describe('lfsPointerOid', () => {
  it('reads the image hash from a pointer', () => {
    expect(lfsPointerOid(Buffer.from(lfsPointer(png('hero'))))).toBe(sha256(png('hero')));
  });

  it('accepts Windows line endings and extra lines', () => {
    const oid = sha256('x');
    const pointer = `version https://git-lfs.github.com/spec/v1\r\next-0-foo sha256:${'b'.repeat(64)}\r\noid sha256:${oid}\r\nsize 1\r\n`;
    expect(lfsPointerOid(Buffer.from(pointer))).toBe(oid);
  });

  it('ignores images, other text and pointers without a valid hash', () => {
    expect(lfsPointerOid(png('hero'))).toBeNull();
    expect(lfsPointerOid(Buffer.from('hello'))).toBeNull();
    expect(lfsPointerOid(Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n'))).toBeNull();
    expect(lfsPointerOid(Buffer.from(`${lfsPointer(png('hero'))}${' '.repeat(1024)}`))).toBeNull();
  });
});

describe('indexFiles', () => {
  it('indexes Git LFS pointers by the hash of their image as well', async () => {
    const root = tempDir();
    writeFiles(root, { 'shots/real.png': png('real'), 'shots/pointer.png': lfsPointer(png('stored in lfs')) });
    const { bySha1, byLfsOid } = await indexFiles(root, ['shots/real.png', 'shots/pointer.png', 'shots/missing.png']);
    expect(bySha1.get(sha1(png('real')))).toEqual(['shots/real.png']);
    expect(byLfsOid.get(sha256(png('stored in lfs')))).toEqual(['shots/pointer.png']);
    expect(byLfsOid.size).toBe(1);
  });
});

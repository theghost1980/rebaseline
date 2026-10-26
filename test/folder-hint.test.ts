import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cdCommand } from '../src/review/folder-hint.js';

describe('cdCommand', () => {
  const base = path.resolve('/work/repos/shop');

  it('uses a relative path when it is short', () => {
    expect(cdCommand(path.join(base, 'e2e'), path.join(base, 'docs'))).toBe(`cd ${path.join('..', 'e2e')}`);
    expect(cdCommand(base, base)).toBe('cd .');
  });

  it('uses the full path when the relative one climbs more than two folders', () => {
    const deep = path.join(base, 'a', 'b', 'c');
    expect(cdCommand(path.join(base, 'e2e'), deep)).toBe(`cd ${path.join(base, 'e2e')}`);
  });

  it('quotes a path with spaces', () => {
    expect(cdCommand(path.join(base, 'my tests'), base)).toBe('cd "my tests"');
  });
});

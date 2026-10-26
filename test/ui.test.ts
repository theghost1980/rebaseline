import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers.js';

const source = readFileSync(path.join(repoRoot, 'src', 'ui', 'main.ts'), 'utf8');

/** The text between `start` and the first `end` after it. */
function between(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from === -1 || to === -1) throw new Error(`${start} not found in src/ui/main.ts`);
  return source.slice(from + start.length, to);
}

describe('review page', () => {
  it('lists every keyboard shortcut in the help panel', () => {
    const bound = [...between('const actions: Record<string, () => void> = {', '\n  };').matchAll(/^\s+(?:'([^']+)'|(\w+)):/gm)].map((m) => m[1] ?? m[2] ?? '');
    const listed = [...between('const rows: [string, string][] = [', '\n    ];').matchAll(/\['([^']*)',/g)].flatMap((m) => (m[1] ?? '').split(/\s+/));
    const shown: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };

    expect(bound.length).toBeGreaterThan(10);
    for (const key of bound) expect(listed).toContain(shown[key] ?? key.toUpperCase());
  });
});

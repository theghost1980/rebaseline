import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers.js';

// test/global-setup.ts builds dist/ before the tests run.
const dist = path.join(repoRoot, 'dist');

describe('the built CLI', () => {
  it('only imports Node built-in modules', () => {
    const code = readFileSync(path.join(dist, 'cli.js'), 'utf8');
    const specifiers = [...code.matchAll(/\bfrom\s*"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)|\brequire\(\s*"([^"]+)"\s*\)/g)].map(
      (m) => m[1] ?? m[2] ?? m[3] ?? '',
    );
    const builtins = new Set(builtinModules);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s.startsWith('node:') && !builtins.has(s))).toEqual([]);
  });

  it('ships the licenses of the packages bundled into it', () => {
    const text = readFileSync(path.join(dist, 'THIRD_PARTY_LICENSES.txt'), 'utf8');
    for (const name of ['@clack/prompts', 'cac', 'fflate', 'picocolors']) expect(text).toContain(`\n${name}@`);
    expect(text).toContain('Permission is hereby granted');
  });

  it('needs no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { dependencies?: object };
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});

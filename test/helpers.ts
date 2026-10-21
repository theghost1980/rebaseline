import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { afterAll, afterEach, beforeEach } from 'vitest';

export const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** The saved Playwright 1.64.1 report generated on Windows. */
export const fixtureDir = path.join(repoRoot, 'fixtures', 'reports', 'pw-1.64.1-win32');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bytes that start like a PNG file; `seed` makes the content (and hash) unique. */
export function png(seed: string): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from(seed)]);
}

export function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A new empty folder, removed after the test file finishes. */
export function tempDir(): string {
  // The native realpath also expands Windows 8.3 short names, like the RUNNER~1 temp folder on CI.
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'rebaseline-test-')));
  tempDirs.push(dir);
  return dir;
}

/** Keeps git from finding a repository above the temporary folders during each test. */
export function isolateGit(): void {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(tempDir());
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = saved;
  });
}

export function writeFiles(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** Installs a stand-in for @playwright/test in `project`. `script` becomes its CLI. */
export function installFakePlaywright(project: string, script: string): void {
  writeFiles(project, {
    'node_modules/@playwright/test/package.json': JSON.stringify({
      name: '@playwright/test',
      version: '0.0.0-test',
      exports: { './cli': './cli.js', './package.json': './package.json' },
    }),
    'node_modules/@playwright/test/cli.js': script,
  });
}

export interface FakeAttachment {
  name: string;
  /** Stored as data/<sha1>.png. */
  content?: Buffer;
  /** Used as is when there is no content. */
  path?: string;
}

export interface FakeResult {
  status?: string;
  errors?: (string | { message: string })[];
  attachments?: FakeAttachment[];
}

export interface FakeTest {
  title: string;
  projectName?: string;
  outcome?: string;
  testId?: string;
  path?: string[];
  results: FakeResult[];
}

/** Writes a minimal Playwright-like HTML report (index.html with the zipped JSON, plus data/). */
export function writeReport(dir: string, tests: FakeTest[]): string {
  const files: Record<string, Uint8Array> = {};
  const jsonTests = tests.map((t, i) => ({
    testId: t.testId ?? `t${i}`,
    title: t.title,
    projectName: t.projectName ?? 'chromium',
    location: { file: 'example.spec.ts', line: i + 1, column: 1 },
    outcome: t.outcome,
    path: t.path ?? [],
    results: t.results.map((r, retry) => ({
      retry,
      status: r.status ?? 'failed',
      errors: r.errors ?? [],
      attachments: (r.attachments ?? []).map((a) => {
        if (a.content) {
          const rel = `data/${sha1(a.content)}.png`;
          writeFiles(dir, { [rel]: a.content });
          return { name: a.name, contentType: 'image/png', path: rel };
        }
        return { name: a.name, contentType: 'image/png', path: a.path };
      }),
    })),
  }));
  files['abc123.json'] = strToU8(JSON.stringify({ fileId: 'abc123', fileName: 'example.spec.ts', tests: jsonTests }));
  files['report.json'] = strToU8(
    JSON.stringify({ files: [{ fileId: 'abc123', fileName: 'example.spec.ts', tests: [] }], projectNames: ['chromium'] }),
  );
  const b64 = Buffer.from(zipSync(files)).toString('base64');
  writeFiles(dir, {
    'index.html': `<!DOCTYPE html><html><body><template id="playwrightReportBase64">data:application/zip;base64,${b64}</template></body></html>`,
  });
  return dir;
}

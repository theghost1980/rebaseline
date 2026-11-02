import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { findReportDir, readReport } from '../src/core/report-reader.js';
import { extractReport } from '../src/review/report-zip.js';
import { fixtureDir, png, tempDir, writeFiles, writeReport, zipDir } from './helpers.js';

function writeZip(files: Record<string, Uint8Array>): string {
  const file = path.join(tempDir(), 'artifact.zip');
  writeFileSync(file, zipSync(files));
  return file;
}

describe('extractReport', () => {
  it('extracts a report zipped at its root, as GitHub downloads an artifact', async () => {
    const file = path.join(tempDir(), 'playwright-report.zip');
    writeFileSync(file, zipDir(path.join(fixtureDir, 'report')));
    const dir = tempDir();

    const names = await extractReport(file, dir);
    expect(names).toContain('index.html');
    expect(await findReportDir(dir)).toBe(dir);
    const report = await readReport(dir);
    expect(report.failures.flatMap((f) => f.shots)).toHaveLength(8);
  });

  it('writes only index.html and the images in data/', async () => {
    const file = writeZip({
      'index.html': strToU8('page'),
      'data/a.png': png('a'),
      'data/b.zip': strToU8('trace'),
      'data/c.md': strToU8('error context'),
      'trace/index.html': strToU8('trace viewer'),
      'trace/logo.png': png('logo'),
      'shot.png': png('loose'),
    });
    const dir = tempDir();

    const names = await extractReport(file, dir);
    expect(names.sort()).toEqual(['data/a.png', 'data/b.zip', 'data/c.md', 'index.html', 'shot.png', 'trace/index.html', 'trace/logo.png']);
    expect(readdirSync(dir, { recursive: true }).map(String).map((f) => f.split(path.sep).join('/')).sort()).toEqual([
      'data',
      'data/a.png',
      'index.html',
      'trace',
      'trace/index.html',
    ]);
  });

  it('never writes outside the folder', async () => {
    const root = tempDir();
    const file = writeZip({ '../escaped/index.html': strToU8('page'), 'report/data/../../../escaped/data/a.png': png('a') });
    const dir = path.join(root, 'extract');

    await extractReport(file, dir);
    expect(existsSync(path.join(root, 'escaped'))).toBe(false);
  });

  it('refuses a file that is not a zip', async () => {
    const file = path.join(tempDir(), 'report.txt');
    writeFileSync(file, 'not a zip');
    await expect(extractReport(file, tempDir())).rejects.toMatchObject({
      name: 'UserError',
      message: expect.stringContaining('is not a report folder or a zip file'),
    });
  });

  it('explains a damaged zip', async () => {
    const file = path.join(tempDir(), 'broken.zip');
    writeFileSync(file, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]));
    await expect(extractReport(file, tempDir())).rejects.toMatchObject({
      name: 'UserError',
      message: expect.stringContaining('could not be read as a zip file'),
    });
  });
});

describe('findReportDir', () => {
  it('finds a report one or more folders down', async () => {
    const root = tempDir();
    const report = writeReport(path.join(root, 'playwright-report (1)', 'playwright-report'), []);
    expect(await findReportDir(root)).toBe(report);
  });

  it('skips node_modules and hidden folders', async () => {
    const root = tempDir();
    writeReport(path.join(root, 'node_modules', 'pkg'), []);
    writeReport(path.join(root, '.cache', 'report'), []);
    expect(await findReportDir(root)).toBeNull();
  });

  it('ignores an index.html that is not a Playwright report', async () => {
    const root = tempDir();
    writeFiles(root, { 'index.html': '<html>site</html>' });
    expect(await findReportDir(root)).toBeNull();
  });
});

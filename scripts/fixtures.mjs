// Regenerates the saved Playwright report used by the tests:
//
//   1. generates the baselines of fixtures/pw-project (UI_COLOR unset),
//   2. copies that baseline tree to fixtures/reports/pw-<version>-<platform>/baselines/,
//   3. runs the tests again with UI_COLOR=changed to provoke every failure case,
//   4. saves the HTML report to fixtures/reports/pw-<version>-<platform>/report/.
//
// Absolute local paths in the saved report are replaced with a neutral prefix
// so no machine paths are committed. On GitHub Actions (GITHUB_ACTIONS=true)
// paths are kept as they are.
//
// Run timings and zip dates are fixed, so regenerating an unchanged project
// produces the same files byte for byte.
//
// It works with Playwright 1.40 and later: CI installs other versions over the
// project's one (see .github/workflows/fixtures.yml), so it only uses options
// all of them understand.
//
// Everything is written to a temporary folder first. The previous fixture is
// only replaced when the new one passes the local data check.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const CI_ROOT = '/home/runner/work/rebaseline/rebaseline';
const ZIP_PREFIX = 'data:application/zip;base64,';
const FIXED_TIME = '2020-01-01T00:00:00.000Z';
// Zip entries store local time, so a local date gives the same bytes in every time zone.
const ZIP_MTIME = new Date(2020, 0, 1);
const RUN_COUNTERS = new Set(['duration', 'workerIndex', 'parallelIndex']);

const inCI = process.env.GITHUB_ACTIONS === 'true';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const projectDir = path.join(root, 'fixtures', 'pw-project');
const reportsDir = path.join(root, 'fixtures', 'reports');
const pwCli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const version = readJson(path.join(root, 'node_modules', '@playwright', 'test', 'package.json')).version;
const outName = `pw-${version}-${process.platform}`;
const outDir = path.join(reportsDir, outName);

class FixtureError extends Error {}

function fail(message) {
  throw new FixtureError(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function playwright(args, uiColor) {
  // Code snippets in the report are only colored when the output is a terminal.
  // Forcing colors gives the same report from a terminal, a pipe or CI.
  const env = { ...process.env, PLAYWRIGHT_HTML_OPEN: 'never', FORCE_COLOR: '1' };
  delete env.NO_COLOR;
  delete env.DEBUG_COLORS;
  delete env.UI_COLOR;
  delete env.PLAYWRIGHT_HTML_OUTPUT_DIR;
  delete env.PLAYWRIGHT_HTML_REPORT;
  delete env.CI;
  if (uiColor) env.UI_COLOR = uiColor;
  console.log(`\n> playwright ${args.join(' ')}${uiColor ? `  (UI_COLOR=${uiColor})` : ''}`);
  const res = spawnSync(process.execPath, [pwCli, ...args], { cwd: projectDir, env, stdio: 'inherit' });
  if (res.error) fail(res.error.message);
  return res.status;
}

/** Relative paths (with /) of every PNG under dir, skipping Playwright output folders. */
function listPngs(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'test-results' || entry.name === 'playwright-report' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listPngs(full, base));
    else if (entry.name.endsWith('.png')) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches an absolute local path (either slash style, any drive letter case) plus the rest of the path. */
function localPathPattern(dir) {
  const parts = dir.split(/[\\/]+/).filter(Boolean).map(escapeRegExp);
  let first = parts.shift() ?? '';
  if (/^[A-Za-z]:$/.test(first)) first = `[${first[0].toLowerCase()}${first[0].toUpperCase()}]:`;
  const lead = process.platform === 'win32' ? '' : '[\\\\/]';
  return new RegExp(`(file:///?)?${lead}${[first, ...parts].join('[\\\\/]')}((?:[\\\\/][\\w.@+-]+)*)`, 'g');
}

const rewrites = inCI
  ? []
  : [
      { pattern: localPathPattern(root), to: CI_ROOT },
      { pattern: localPathPattern(os.homedir()), to: '/home/runner' },
    ];

function sanitizeString(s) {
  let out = s;
  for (const { pattern, to } of rewrites) {
    out = out.replace(pattern, (_m, fileUrl, rest) => `${fileUrl ? 'file://' : ''}${to}${rest.replace(/\\/g, '/')}`);
  }
  return out;
}

function sanitizeValue(value) {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeValue(v)]));
  }
  return value;
}

/** Replaces values that change on every run (start times, durations, worker numbers). */
function fixTimings(value) {
  if (Array.isArray(value)) return value.map(fixTimings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (k === 'startTime' && typeof v === 'string') return [k, FIXED_TIME];
        if (k === 'startTime' && typeof v === 'number') return [k, Date.parse(FIXED_TIME)];
        if (RUN_COUNTERS.has(k) && typeof v === 'number') return [k, 0];
        return [k, fixTimings(v)];
      }),
    );
  }
  return value;
}

/** Splits a report index.html around its embedded base64 zip. */
function splitReportHtml(html) {
  const start = html.indexOf(ZIP_PREFIX);
  if (start === -1) fail('the HTML report has no embedded zip');
  const b64Start = start + ZIP_PREFIX.length;
  let b64End = b64Start;
  while (b64End < html.length && /[A-Za-z0-9+/=]/.test(html[b64End])) b64End++;
  return { before: html.slice(0, b64Start), b64: html.slice(b64Start, b64End), after: html.slice(b64End) };
}

function saveReport(fromDir, toDir) {
  // Attachments are named after the SHA-1 of their content. Images are copied
  // untouched; text attachments (error-context.md) are sanitized, renamed to
  // their new hash, and the JSON references are updated to match.
  const renamed = new Map();
  fs.mkdirSync(path.join(toDir, 'data'), { recursive: true });
  for (const name of fs.readdirSync(path.join(fromDir, 'data'))) {
    const from = path.join(fromDir, 'data', name);
    const ext = path.extname(name);
    if (!['.md', '.txt', '.json', '.yml'].includes(ext)) {
      fs.copyFileSync(from, path.join(toDir, 'data', name));
      continue;
    }
    const text = sanitizeString(fs.readFileSync(from, 'utf8'));
    const newName = `${createHash('sha1').update(text).digest('hex')}${ext}`;
    if (newName !== name) renamed.set(`data/${name}`, `data/${newName}`);
    fs.writeFileSync(path.join(toDir, 'data', newName), text);
  }

  const { before, b64, after } = splitReportHtml(fs.readFileSync(path.join(fromDir, 'index.html'), 'utf8'));
  const files = unzipSync(new Uint8Array(Buffer.from(b64, 'base64')));
  const cleaned = {};
  for (const name of Object.keys(files).sort()) {
    const data = files[name];
    if (!name.endsWith('.json')) {
      cleaned[name] = data;
      continue;
    }
    let json = JSON.stringify(fixTimings(sanitizeValue(JSON.parse(strFromU8(data)))));
    for (const [from, to] of renamed) json = json.split(JSON.stringify(from)).join(JSON.stringify(to));
    cleaned[name] = strToU8(json);
  }
  const zip = zipSync(cleaned, { mtime: ZIP_MTIME });
  fs.writeFileSync(path.join(toDir, 'index.html'), before + Buffer.from(zip).toString('base64') + after);
}

/**
 * Looks for data of this machine in every text file under dir, including the
 * JSON inside the report zip. Paths are matched as substrings; the user and
 * host names only as whole words, so short names do not match inside
 * Playwright's minified viewer code. PNG files are screenshots and skipped.
 */
function findLocalData(dir) {
  const paths = [root, os.homedir()].flatMap((p) => [p, p.replace(/\\/g, '/'), p.replace(/\\/g, '\\\\')]);
  const words = [os.userInfo().username, os.hostname()].filter((w) => w.length >= 3);
  const wordPatterns = words.map((w) => new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(w)}(?![A-Za-z0-9])`, 'i'));

  const found = [];
  for (const rel of fs.readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, String(rel));
    if (!fs.statSync(file).isFile() || file.endsWith('.png')) continue;
    let text = fs.readFileSync(file, 'utf8');
    if (path.basename(file) === 'index.html') {
      const { before, b64, after } = splitReportHtml(text);
      const files = unzipSync(new Uint8Array(Buffer.from(b64, 'base64')));
      text = [before, after, ...Object.values(files).map((d) => strFromU8(d))].join('\n');
    }
    const lower = text.toLowerCase();
    for (const p of paths) if (lower.includes(p.toLowerCase())) found.push(`${path.relative(dir, file)}: a local path`);
    for (const [i, re] of wordPatterns.entries()) if (re.test(text)) found.push(`${path.relative(dir, file)}: "${words[i]}"`);
  }
  return found;
}

/** Puts `from` in place of `to`. If the second rename fails the previous `to` is restored. */
function replaceDir(from, to) {
  if (!fs.existsSync(to)) {
    fs.renameSync(from, to);
    return;
  }
  const old = path.join(path.dirname(to), `.old-${path.basename(to)}-${process.pid}`);
  fs.renameSync(to, old);
  try {
    fs.renameSync(from, to);
  } catch (err) {
    fs.renameSync(old, to);
    throw err;
  }
  fs.rmSync(old, { recursive: true, force: true });
}

function main() {
  // 1. Baselines, without the "new screenshot" test so it never has one. A bare
  //    --update-snapshots means "changed" since 1.50 (identical files are left
  //    untouched) and "all" before; both give the same baselines.
  if (playwright(['test', '--grep-invert', 'new screenshot', '--reporter=list', '--update-snapshots']) !== 0) {
    fail('generating the baselines failed. If the browser is missing, run: npx playwright install --only-shell chromium');
  }
  const baselines = listPngs(projectDir);

  fs.mkdirSync(reportsDir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(reportsDir, `.tmp-${outName}-`));
  try {
    for (const rel of baselines) {
      const dest = path.join(tmpDir, 'baselines', rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(projectDir, rel), dest);
    }

    // 2. Failures. Retries exercise "use the last result". One worker keeps the
    //    order of tests, and so the steps each one reports, the same every time.
    const status = playwright(['test', '--retries=1', '--workers=1'], 'changed');

    // Playwright writes missing snapshots next to the baselines even when the test fails.
    // Remove only those freshly written files so the fixture project matches git again.
    const created = listPngs(projectDir).filter((rel) => !baselines.includes(rel));
    for (const rel of created) fs.rmSync(path.join(projectDir, rel));

    if (status !== 1) fail(`the failing run was expected to exit with code 1, got ${status}`);

    saveReport(path.join(projectDir, 'playwright-report'), path.join(tmpDir, 'report'));
    fs.writeFileSync(
      path.join(tmpDir, 'meta.json'),
      `${JSON.stringify(
        {
          playwright: version,
          platform: process.platform,
          projectPath: 'fixtures/pw-project',
          pathsRewrittenTo: inCI ? null : CI_ROOT,
          newSnapshots: created,
        },
        null,
        2,
      )}\n`,
    );

    if (!inCI) {
      const found = findLocalData(tmpDir);
      if (found.length > 0) fail(`local data left in the saved report, nothing was replaced:\n  ${found.join('\n  ')}`);
    }

    replaceDir(tmpDir, outDir);
    console.log(`\nSaved ${path.relative(root, outDir)} (${baselines.length} baselines, ${created.length} new snapshots removed from the project).`);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

try {
  main();
} catch (err) {
  console.error(`fixtures: ${err instanceof FixtureError ? err.message : (err?.stack ?? err)}`);
  process.exitCode = 1;
}

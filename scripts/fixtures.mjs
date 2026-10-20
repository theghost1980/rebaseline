// Regenerates the saved Playwright report used by the tests:
//
//   1. generates the baselines of fixtures/pw-project (UI_COLOR unset),
//   2. copies that baseline tree to fixtures/reports/pw-<version>/baselines/,
//   3. runs the tests again with UI_COLOR=changed to provoke every failure case,
//   4. saves the HTML report to fixtures/reports/pw-<version>/report/.
//
// Absolute local paths in the saved report are replaced with a neutral prefix
// so no machine paths are committed.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const CI_ROOT = '/home/runner/work/rebaseline/rebaseline';
const ZIP_PREFIX = 'data:application/zip;base64,';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const projectDir = path.join(root, 'fixtures', 'pw-project');
const pwCli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const version = readJson(path.join(root, 'node_modules', '@playwright', 'test', 'package.json')).version;
const outDir = path.join(root, 'fixtures', 'reports', `pw-${version}`);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fail(message) {
  console.error(`fixtures: ${message}`);
  process.exit(1);
}

function playwright(args, uiColor) {
  const env = { ...process.env, PLAYWRIGHT_HTML_OPEN: 'never' };
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

const rewrites = [
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

  const html = fs.readFileSync(path.join(fromDir, 'index.html'), 'utf8');
  const start = html.indexOf(ZIP_PREFIX);
  if (start === -1) fail('the HTML report has no embedded zip');
  const b64Start = start + ZIP_PREFIX.length;
  let b64End = b64Start;
  while (b64End < html.length && /[A-Za-z0-9+/=]/.test(html[b64End])) b64End++;

  const files = unzipSync(new Uint8Array(Buffer.from(html.slice(b64Start, b64End), 'base64')));
  const cleaned = {};
  for (const [name, data] of Object.entries(files)) {
    if (!name.endsWith('.json')) {
      cleaned[name] = data;
      continue;
    }
    let json = JSON.stringify(sanitizeValue(JSON.parse(strFromU8(data))));
    for (const [from, to] of renamed) json = json.split(JSON.stringify(from)).join(JSON.stringify(to));
    cleaned[name] = strToU8(json);
  }
  const b64 = Buffer.from(zipSync(cleaned)).toString('base64');
  fs.writeFileSync(path.join(toDir, 'index.html'), html.slice(0, b64Start) + b64 + html.slice(b64End));
}

function checkNoLocalPaths(dir) {
  const needles = [os.userInfo().username, root, root.replace(/\\/g, '/')].filter((n) => n.length > 2);
  for (const rel of fs.readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, String(rel));
    if (!fs.statSync(file).isFile()) continue;
    let text = fs.readFileSync(file, 'latin1');
    if (file.endsWith('index.html')) {
      const start = text.indexOf(ZIP_PREFIX) + ZIP_PREFIX.length;
      const b64 = text.slice(start).match(/^[A-Za-z0-9+/=]+/)[0];
      const files = unzipSync(new Uint8Array(Buffer.from(b64, 'base64')));
      text += Object.values(files).map((d) => strFromU8(d)).join('\n');
    }
    for (const needle of needles) {
      if (text.toLowerCase().includes(needle.toLowerCase())) fail(`local path or user name left in ${path.relative(root, file)}`);
    }
  }
}

// 1. Baselines. "changed" writes missing and different snapshots and leaves identical ones untouched.
if (playwright(['test', '--update-snapshots=changed', '--grep-invert', '@new', '--reporter=list']) !== 0) {
  fail('generating the baselines failed. If the browser is missing, run: npx playwright install --only-shell chromium');
}
const baselines = listPngs(projectDir);

fs.rmSync(outDir, { recursive: true, force: true });
for (const rel of baselines) {
  const dest = path.join(outDir, 'baselines', rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(projectDir, rel), dest);
}

// 2. Failures. Retries exercise "use the last result".
if (playwright(['test', '--retries=1'], 'changed') !== 1) {
  fail('the failing run was expected to exit with code 1');
}

// Playwright writes missing snapshots next to the baselines even when the test fails.
// Remove only those freshly written files so the fixture project matches git again.
const created = listPngs(projectDir).filter((rel) => !baselines.includes(rel));
for (const rel of created) fs.rmSync(path.join(projectDir, rel));

saveReport(path.join(projectDir, 'playwright-report'), path.join(outDir, 'report'));
checkNoLocalPaths(outDir);

fs.writeFileSync(
  path.join(outDir, 'meta.json'),
  `${JSON.stringify(
    {
      playwright: version,
      platform: process.platform,
      projectPath: 'fixtures/pw-project',
      ciRoot: CI_ROOT,
      note: 'Absolute local paths in report/ were rewritten to ciRoot. baselines/ holds the baseline tree before the failing run, relative to projectPath.',
      newSnapshots: created,
    },
    null,
    2,
  )}\n`,
);

console.log(`\nSaved ${path.relative(root, outDir)} (${baselines.length} baselines, ${created.length} new snapshots removed from the project).`);

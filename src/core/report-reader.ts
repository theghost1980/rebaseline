import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { strFromU8, unzipSync } from 'fflate';
import { UserError } from '../lib/errors.js';
import { displayPath, isInside, toPosix } from '../lib/paths.js';
import type { Failure, Report, ReportImage, Shot } from './types.js';

const ZIP_PATTERN = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/;
const ACTUAL_SUFFIX = '-actual.png';
const MISSING_SNAPSHOT = /A snapshot doesn't exist at (.+?)(?:, writing actual\.|\.)[ \t]*$/gm;

export type ReportErrorCode = 'not-found' | 'invalid';

export class ReportError extends UserError {
  readonly code: ReportErrorCode;

  constructor(code: ReportErrorCode, message: string, hint?: string) {
    super(message, hint);
    this.name = 'ReportError';
    this.code = code;
  }
}

/** Reads a Playwright HTML report folder and returns the tests that did not pass. */
export async function readReport(dir: string): Promise<Report> {
  const reportDir = path.resolve(dir);
  const entries = await unpack(reportDir);

  const summary = parseJson(entries.get('report.json'));
  const projectNames = asArray(summary?.projectNames).filter(isString);

  const failures: Failure[] = [];
  const usedIds = new Set<string>();
  for (const test of collectTests(entries, summary)) {
    const failure = await toFailure(reportDir, test, usedIds);
    if (failure) failures.push(failure);
  }

  return { dir: reportDir, projectNames, failures: sortFailures(failures, projectNames) };
}

/** Joins the reports of several shards into one. Ids stay unique. */
export function mergeReports(reports: Report[], dir: string): Report {
  const projectNames = [...new Set(reports.flatMap((r) => r.projectNames))];
  const usedIds = new Set<string>();
  const failures = reports
    .flatMap((r) => r.failures)
    .map((f) => {
      const id = uniqueId(f.id, usedIds);
      return id === f.id ? f : { ...f, id, shots: f.shots.map((s, i) => ({ ...s, id: `${id}:${i}` })) };
    });
  return { dir, projectNames, failures: sortFailures(failures, projectNames) };
}

/** Project order of the config, then file and position. */
function sortFailures(failures: Failure[], projectNames: string[]): Failure[] {
  const projectOrder = (name: string) => {
    const i = projectNames.indexOf(name);
    return i === -1 ? projectNames.length : i;
  };
  return failures.sort(
    (a, b) =>
      projectOrder(a.projectName) - projectOrder(b.projectName) ||
      a.projectName.localeCompare(b.projectName) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column ||
      a.title.localeCompare(b.title),
  );
}

async function unpack(reportDir: string): Promise<Map<string, Uint8Array>> {
  const where = displayPath(reportDir);
  let html: string;
  try {
    html = await readFile(path.join(reportDir, 'index.html'), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new ReportError(
        'not-found',
        `No Playwright HTML report found in ${where}`,
        'Run your tests with the HTML reporter first: npx playwright test --reporter=html',
      );
    }
    throw new ReportError('invalid', `Could not read ${path.join(where, 'index.html')} (${code ?? 'unknown error'})`);
  }

  const match = ZIP_PATTERN.exec(html);
  if (!match?.[1]) {
    throw new ReportError(
      'invalid',
      `${path.join(where, 'index.html')} is not a Playwright HTML report`,
      "Use the folder written by Playwright's HTML reporter (it contains index.html and data/).",
    );
  }

  try {
    return new Map(Object.entries(unzipSync(new Uint8Array(Buffer.from(match[1], 'base64')))));
  } catch {
    throw new ReportError('invalid', `The report in ${where} is damaged`, 'Run your tests again to produce a new report.');
  }
}

/** Tests from the per-file JSON entries; report.json only holds a summary of them. */
function collectTests(entries: Map<string, Uint8Array>, summary: Json | null): Json[] {
  const fileIds = asArray(summary?.files)
    .map((f) => asRecord(f)?.fileId)
    .filter(isString);
  let names = fileIds.map((id) => `${id}.json`).filter((name) => entries.has(name));
  if (names.length === 0) names = [...entries.keys()].filter((n) => n.endsWith('.json') && n !== 'report.json');

  const tests = names.flatMap((name) => asArray(parseJson(entries.get(name))?.tests));
  if (tests.length === 0) {
    // Fall back to the summary when the report has no per-file entries.
    return asArray(summary?.files).flatMap((f) => asArray(asRecord(f)?.tests)).filter(isRecord);
  }
  return tests.filter(isRecord);
}

async function toFailure(reportDir: string, test: Json, usedIds: Set<string>): Promise<Failure | null> {
  const results = asArray(test.results).filter(isRecord);
  const last = results.at(-1);
  if (!last) return null;

  const status = asString(last.status) ?? 'unknown';
  const outcome = asString(test.outcome);
  // "expected" also covers tests marked with test.fail(); "flaky" passed on retry.
  if (outcome ? outcome !== 'unexpected' : status === 'passed' || status === 'skipped') return null;

  const title = asString(test.title) ?? '';
  const location = asRecord(test.location);
  const id = uniqueId(asString(test.testId) ?? `test-${usedIds.size + 1}`, usedIds);

  const error = asArray(last.errors)
    .map((e) => (isString(e) ? e : (asString(asRecord(e)?.message) ?? '')))
    .map((e) => stripVTControlCharacters(e).trim())
    .filter(Boolean)
    .join('\n\n');

  const attachments = new Map<string, string | null>();
  for (const a of asArray(last.attachments)) {
    const name = asString(asRecord(a)?.name);
    if (name) attachments.set(name, asString(asRecord(a)?.path));
  }

  const shots: Shot[] = [];
  for (const [name, file] of attachments) {
    if (!name.endsWith(ACTUAL_SUFFIX)) continue;
    const actual = await loadImage(reportDir, file);
    if (!actual) continue;
    const base = name.slice(0, -ACTUAL_SUFFIX.length);
    shots.push({
      id: `${id}:${shots.length}`,
      name: base,
      actual,
      expected: await loadImage(reportDir, attachments.get(`${base}-expected.png`)),
      diff: await loadImage(reportDir, attachments.get(`${base}-diff.png`)),
      missingPath: null,
    });
  }

  const missingSnapshots = [...new Set([...error.matchAll(MISSING_SNAPSHOT)].map((m) => (m[1] ?? '').trim()))].filter(Boolean);
  assignMissingPaths(shots, missingSnapshots);

  return {
    id,
    title,
    titlePath: [...asArray(test.path).filter(isString), title],
    projectName: asString(test.projectName) ?? '',
    file: toPosix(asString(location?.file) ?? ''),
    line: asNumber(location?.line) ?? 0,
    column: asNumber(location?.column) ?? 0,
    status,
    retries: results.length - 1,
    error,
    shots,
    missingSnapshots,
    stoppedAtScreenshot: shots.some((s) => s.missingPath === null),
  };
}

/**
 * Matches each "snapshot doesn't exist" path with its screenshot. Only shots
 * that look new qualify: no expected image, or an expected image identical to
 * the actual one (Playwright writes the actual image as the new snapshot).
 * The longest screenshot name that prefixes the file name wins.
 */
function assignMissingPaths(shots: Shot[], paths: string[]): void {
  const eligible = shots.filter((s) => !s.expected || (s.expected.sha1 !== null && s.expected.sha1 === s.actual.sha1));
  const unassigned: string[] = [];

  for (const p of paths) {
    const file = lastSegment(p);
    let best: Shot | null = null;
    for (const shot of eligible) {
      if (shot.missingPath !== null) continue;
      const name = lastSegment(shot.name);
      if (file.startsWith(name) && (!best || name.length > lastSegment(best.name).length)) best = shot;
    }
    if (best) best.missingPath = p;
    else unassigned.push(p);
  }

  // Names can differ from the file name (repeated or very long names); pair a single leftover.
  const left = eligible.filter((s) => s.missingPath === null);
  const [onlyPath] = unassigned;
  const [onlyShot] = left;
  if (unassigned.length === 1 && left.length === 1 && onlyPath && onlyShot) onlyShot.missingPath = onlyPath;
}

async function loadImage(reportDir: string, rel: string | null | undefined): Promise<ReportImage | null> {
  if (!rel) return null;
  const file = path.resolve(reportDir, rel);
  // Paths come from the report JSON; never read outside the report folder.
  if (!isInside(reportDir, file)) return null;
  try {
    return { file, sha1: createHash('sha1').update(await readFile(file)).digest('hex') };
  } catch {
    return { file, sha1: null };
  }
}

function lastSegment(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

// Minimal helpers to read untrusted JSON without assuming its shape.

type Json = Record<string, unknown>;

function parseJson(data: Uint8Array | undefined): Json | null {
  if (!data) return null;
  try {
    return asRecord(JSON.parse(strFromU8(data)));
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asRecord(v: unknown): Json | null {
  return isRecord(v) ? v : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

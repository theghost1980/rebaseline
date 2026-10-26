import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/*
 * Each download goes to its own folder in the system temporary folder, removed
 * when the review ends. A process that is killed cannot remove it, so the
 * folder holds a marker file that says who made it, and later runs remove
 * folders like that once they are old and their process is gone.
 */

const PREFIX = 'rebaseline-pull-';
const MARKER = '.rebaseline-pull.json';
/** A review can stay open for hours; older downloads were left behind. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

interface Marker {
  tool: 'rebaseline';
  pid: number;
  created: string;
}

/** Creates the folder for one download, with its marker. */
export async function makeDownloadDir(root = os.tmpdir()): Promise<string> {
  const dir = await mkdtemp(path.join(root, PREFIX));
  const marker: Marker = { tool: 'rebaseline', pid: process.pid, created: new Date().toISOString() };
  await writeFile(path.join(dir, MARKER), JSON.stringify(marker));
  return dir;
}

/**
 * Removes the download folders that killed processes left behind: only folders
 * with the prefix and a valid marker, older than a day, whose process is not
 * running. Never fails; returns how many were removed.
 */
export async function removeStaleDownloads(root = os.tmpdir(), now = Date.now()): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue;
    const dir = path.join(root, entry.name);
    const marker = await readMarker(dir);
    if (!marker || now - Date.parse(marker.created) < STALE_AFTER_MS || isRunning(marker.pid)) continue;
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 2 });
      removed++;
    } catch {
      // Still in use or not ours to remove; try again next time.
    }
  }
  return removed;
}

async function readMarker(dir: string): Promise<Marker | null> {
  try {
    const marker = JSON.parse(await readFile(path.join(dir, MARKER), 'utf8')) as Partial<Marker>;
    const valid = marker.tool === 'rebaseline' && Number.isInteger(marker.pid) && !Number.isNaN(Date.parse(marker.created ?? ''));
    return valid ? (marker as Marker) : null;
  } catch {
    return null;
  }
}

/** True unless the process is known to be gone; a reused process id only keeps a folder longer. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

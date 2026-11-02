import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { errorMessage, UserError } from '../lib/errors.js';
import { displayPath, isInside } from '../lib/paths.js';

/** Every zip file starts with a local file header. */
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * Extracts a zipped Playwright HTML report, such as an artifact downloaded
 * from a workflow run page, into `dir`. Only the files rebaseline reads are
 * written (each index.html and the images in data/ folders), never outside
 * `dir`. Returns the paths of all the files in the zip.
 */
export async function extractReport(file: string, dir: string): Promise<string[]> {
  const shown = displayPath(file);
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_FS_FILE_TOO_LARGE') {
      throw new UserError(`${shown} is too large to read`, 'Extract it and point --report at the folder.');
    }
    throw err;
  }
  if (!data.subarray(0, ZIP_SIGNATURE.length).equals(ZIP_SIGNATURE)) {
    throw new UserError(`${shown} is not a report folder or a zip file`, 'Point --report at the Playwright HTML report folder, or at the zip of a report artifact.');
  }

  const names: string[] = [];
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, {
      filter: (entry) => {
        names.push(entry.name);
        return isReportFile(entry.name);
      },
    });
  } catch (err) {
    throw new UserError(`${shown} could not be read as a zip file (${errorMessage(err)})`, 'Download it again, or extract it and point --report at the folder.');
  }

  const root = path.resolve(dir);
  for (const [name, content] of Object.entries(entries)) {
    const target = path.resolve(root, name);
    // Names come from the zip; never write outside the folder.
    if (!isInside(root, target)) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return names;
}

/** index.html files and the images in data/ folders, where the HTML reporter puts attachments. */
function isReportFile(name: string): boolean {
  const parts = name.split(/[\\/]/);
  const base = parts.at(-1) ?? '';
  return base === 'index.html' || (parts.at(-2) === 'data' && /\.png$/i.test(base));
}

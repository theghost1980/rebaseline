import path from 'node:path';
import { readReport } from '../src/core/report-reader.js';
import { hashFiles, resolveReport } from '../src/core/resolver.js';
import { ReviewSession } from '../src/review/session.js';
import { png, tempDir, writeFiles, writeReport } from './helpers.js';

/** A repository with one baseline and a report with a changed, a new and an unresolvable screenshot. */
export async function makeSession() {
  const root = tempDir();
  writeFiles(root, { 'shots/hero.png': png('hero old'), 'shots/other.png': png('other old') });
  const reportDir = writeReport(tempDir(), [
    {
      title: 'hero',
      testId: 'hero',
      results: [
        {
          attachments: [
            { name: 'hero-actual.png', content: png('hero new') },
            { name: 'hero-expected.png', content: png('hero old') },
            { name: 'hero-diff.png', content: png('hero diff') },
          ],
        },
      ],
    },
    {
      title: 'hero again, same baseline',
      testId: 'twin',
      results: [
        {
          attachments: [
            { name: 'hero-actual.png', content: png('hero newer') },
            { name: 'hero-expected.png', content: png('hero old') },
          ],
        },
      ],
    },
    {
      title: 'brand new',
      testId: 'new',
      results: [
        {
          errors: [`Error: A snapshot doesn't exist at ${path.join(root, 'shots', 'brand.png')}, writing actual.`],
          attachments: [{ name: 'brand-actual.png', content: png('brand') }],
        },
      ],
    },
    {
      title: 'lost',
      testId: 'lost',
      results: [
        {
          attachments: [
            { name: 'lost-actual.png', content: png('lost new') },
            { name: 'lost-expected.png', content: png('nowhere') },
          ],
        },
      ],
    },
    { title: 'text', testId: 'text', results: [{ errors: ['Error: expected "a" to be "b"'] }] },
  ]);
  const report = await readReport(reportDir);
  const index = await hashFiles(root, ['shots/hero.png', 'shots/other.png']);
  const session = new ReviewSession(report, resolveReport(report, { root, index }), root);
  const id = (testId: string) => `${testId}:0`;
  return { root, session, id };
}

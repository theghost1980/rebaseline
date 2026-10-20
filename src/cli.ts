import { cac } from 'cac';
import { errorMessage, isUserError } from './lib/errors.js';
import { log } from './lib/output.js';

const ISSUES_URL = 'https://github.com/theghost1980/rebaseline/issues';

const cli = cac('rebaseline');

cli.command('[...args]', '').action((args: string[]) => {
  if (args.length > 0) {
    log.error(`Unknown command: ${args[0]}`, 'Run "rebaseline --help" to see the available commands.');
    process.exitCode = 1;
    return;
  }
  cli.outputHelp();
});

// The catch-all command above only exists to reject unknown commands; keep it out of the help.
cli.help((sections) => {
  for (const section of sections) {
    if (section.title === 'Usage' && section.body.includes('[...args]')) {
      section.body = '  $ rebaseline <command> [options]';
    }
    if (section.title === 'Commands') {
      section.body = section.body
        .split('\n')
        .filter((line) => !line.trim().startsWith('[...args]'))
        .join('\n');
    }
  }
  return sections.filter((section) => section.body.trim() !== '');
});
cli.version(__VERSION__);

function handleError(err: unknown): void {
  process.exitCode = 1;
  if (isUserError(err)) {
    log.error(err.message, err.hint);
    return;
  }
  // cac throws CACError for unknown options and missing values.
  if (err instanceof Error && err.name === 'CACError') {
    log.error(err.message, 'Run "rebaseline --help" to see the available options.');
    return;
  }
  log.error(
    `Unexpected error: ${errorMessage(err)}`,
    `Run again with REBASELINE_DEBUG=1 for details and report it at ${ISSUES_URL}`,
  );
  if (process.env.REBASELINE_DEBUG && err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
}

async function main(): Promise<void> {
  try {
    cli.parse(process.argv, { run: false });
    await cli.runMatchedCommand();
  } catch (err) {
    handleError(err);
  }
}

void main();

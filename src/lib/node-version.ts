import { UserError } from './errors.js';

/** The oldest Node.js major version the CLI runs on, as "engines" in package.json says. */
const MIN_MAJOR = 22;

/**
 * Fails with a clear message on an older Node.js. npm only warns about
 * "engines", so without this the CLI would fail later with an error that does
 * not say why.
 */
export function checkNodeVersion(version = process.versions.node): void {
  const major = Number(version.split('.')[0]);
  if (major < MIN_MAJOR) {
    throw new UserError(`rebaseline needs Node.js ${MIN_MAJOR} or newer, and this is Node.js ${version}`, 'Install a newer version from https://nodejs.org, then run it again.');
  }
}

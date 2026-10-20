import { build } from 'tsup';

/** The CLI tests run the real bundle, so build it once before the suite. */
export default async function setup(): Promise<void> {
  await build({ silent: true });
}

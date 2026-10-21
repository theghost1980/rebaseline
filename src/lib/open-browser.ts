import { spawn } from 'node:child_process';

/**
 * Opens `url` in the default browser. Resolves to false when that was not
 * possible; the caller always prints the address anyway.
 */
export function openBrowser(url: string): Promise<boolean> {
  // Only plain http addresses built by us are opened; this keeps the cmd.exe quoting below safe.
  if (!/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+$/.test(url)) return Promise.resolve(false);

  const [command, args, verbatim] =
    process.platform === 'win32'
      ? // Same shape Node uses for shell commands: cmd.exe /d /s /c "start "" "<url>""
        (['cmd.exe', ['/d', '/s', '/c', `"start "" "${url}""`], true] as const)
      : process.platform === 'darwin'
        ? (['open', [url], false] as const)
        : (['xdg-open', [url], false] as const);

  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    try {
      const child = spawn(command, [...args], {
        stdio: 'ignore',
        detached: process.platform !== 'win32',
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
      });
      child.once('error', () => done(false));
      child.once('exit', (code) => done(code === 0));
      child.unref();
      // Some openers keep running while the browser starts; do not wait for them.
      setTimeout(() => done(true), 3000).unref();
    } catch {
      done(false);
    }
  });
}

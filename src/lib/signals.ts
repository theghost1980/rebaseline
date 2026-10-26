/**
 * Calls `handler` when the CLI is asked to stop, until the returned function is
 * called: Ctrl+C (SIGINT), kill (SIGTERM), and closing the terminal window
 * (SIGHUP, which Node also emits on Windows, about ten seconds before Windows
 * ends the process).
 */
export function onStopSignal(handler: () => void): () => void {
  const onHangUp = () => {
    ignoreWriteErrors();
    handler();
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  process.on('SIGHUP', onHangUp);
  return () => {
    process.removeListener('SIGINT', handler);
    process.removeListener('SIGTERM', handler);
    process.removeListener('SIGHUP', onHangUp);
  };
}

let ignoring = false;

/** After SIGHUP the terminal is gone; a failed write must not stop the cleanup that follows. */
function ignoreWriteErrors(): void {
  if (ignoring) return;
  ignoring = true;
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
}

/**
 * An error the user can act on. The CLI prints `message` and `hint` as two
 * short lines and never shows a stack trace for it.
 */
export class UserError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'UserError';
    this.hint = hint;
  }
}

export function isUserError(err: unknown): err is UserError {
  return err instanceof UserError;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

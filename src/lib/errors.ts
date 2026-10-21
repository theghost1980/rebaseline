/**
 * An error the user can act on. The CLI prints `message` and `hint` as two
 * short lines and never shows a stack trace for it. `details` is an optional
 * block printed after them, such as a snippet to copy.
 */
export class UserError extends Error {
  readonly hint: string | undefined;
  readonly details: string | undefined;

  constructor(message: string, hint?: string, details?: string) {
    super(message);
    this.name = 'UserError';
    this.hint = hint;
    this.details = details;
  }
}

export function isUserError(err: unknown): err is UserError {
  return err instanceof UserError;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

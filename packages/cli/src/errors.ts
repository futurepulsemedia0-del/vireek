/** Process exit codes. 130 is the POSIX convention for "terminated by SIGINT". */
export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, AUTH: 3, INTERRUPTED: 130 } as const;

export interface CliErrorOptions {
  exitCode?: number;
  /** One actionable line shown under the error message. */
  hint?: string;
  cause?: unknown;
}

/** An expected, user-facing failure. Anything else is treated as a bug. */
export class CliError extends Error {
  readonly exitCode: number;
  readonly hint?: string;

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CliError';
    this.exitCode = options.exitCode ?? EXIT.ERROR;
    this.hint = options.hint;
  }
}

export class ApiError extends CliError {
  readonly status: number;

  constructor(status: number, message: string, options: CliErrorOptions = {}) {
    super(message, options);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError(message, { exitCode: EXIT.USAGE, hint });
}

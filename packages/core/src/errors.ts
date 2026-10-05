/** Process exit codes shared by every Orbit CLI command. */
export const ExitCode = {
  ok: 0,
  error: 1,
  usage: 2,
  /** No usable credentials: run `orbit login-help`. */
  authRequired: 3,
  /** CliDriver refused by the compliance guard. */
  complianceRefused: 4,
  runFailed: 5,
  notFound: 6,
  /** A kill switch or paused Bot blocked the action. */
  blocked: 7,
  /** The Run is parked waiting for your approval (`orbit approvals`). */
  waitingApproval: 10,
  /** The Run is paused (`orbit resume <run>`, ADR-016). */
  paused: 11,
  /** Usage limit reached; retry after reset (EX_TEMPFAIL). */
  rateLimited: 75,
  cancelled: 130,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export type OrbitErrorCode =
  | 'auth_required'
  | 'compliance_refused'
  | 'driver_unavailable'
  | 'invalid_config'
  | 'invalid_input'
  | 'not_found'
  | 'engine_error'
  | 'blocked'
  /** The resource changed concurrently (compare-and-set failed); retry. */
  | 'conflict'
  /** The local daemon is not running or not reachable. */
  | 'daemon_unavailable'
  /** The API refused the client's token, host or origin. */
  | 'unauthorized'
  | 'forbidden'
  | 'internal';

const EXIT_FOR_CODE: Record<OrbitErrorCode, ExitCode> = {
  auth_required: ExitCode.authRequired,
  compliance_refused: ExitCode.complianceRefused,
  driver_unavailable: ExitCode.authRequired,
  invalid_config: ExitCode.usage,
  invalid_input: ExitCode.usage,
  not_found: ExitCode.notFound,
  engine_error: ExitCode.runFailed,
  blocked: ExitCode.blocked,
  conflict: ExitCode.error,
  daemon_unavailable: ExitCode.error,
  unauthorized: ExitCode.error,
  forbidden: ExitCode.error,
  internal: ExitCode.error,
};

export class OrbitError extends Error {
  readonly code: OrbitErrorCode;
  /** Actionable next step for humans (shown under the message). */
  readonly hint: string | undefined;

  constructor(code: OrbitErrorCode, message: string, options?: { hint?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OrbitError';
    this.code = code;
    this.hint = options?.hint;
  }

  get exitCode(): ExitCode {
    return EXIT_FOR_CODE[this.code];
  }

  toJSON(): { code: OrbitErrorCode; message: string; hint: string | null } {
    return { code: this.code, message: this.message, hint: this.hint ?? null };
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}

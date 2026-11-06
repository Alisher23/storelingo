export type ErrorCode =
  | "E_CONFIG"
  | "E_USAGE"
  | "E_AUTH_PLAY"
  | "E_AUTH_ASC"
  | "E_NO_EDITABLE_VERSION"
  | "E_LOCALE_UNSUPPORTED"
  | "E_LIMIT"
  | "E_MISSING"
  | "E_FORMAT"
  | "E_TRANSLATOR"
  | "E_IN_REVIEW"
  | "E_STORE";

export class StorelingoError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "StorelingoError";
  }
}

export const ExitCode = { OK: 0, FAILED: 1, USAGE: 2 } as const;

export function exitCodeFor(err: unknown): number {
  if (err instanceof StorelingoError && (err.code === "E_CONFIG" || err.code === "E_USAGE")) {
    return ExitCode.USAGE;
  }
  return ExitCode.FAILED;
}

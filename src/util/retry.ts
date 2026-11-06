export class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retries only RetryableError, with exponential backoff and jitter. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const baseMs = opts.baseMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RetryableError) || attempt >= attempts) throw err;
      const delay = err.retryAfterMs ?? baseMs * 2 ** (attempt - 1) + Math.floor(random() * baseMs);
      await sleep(delay);
    }
  }
}

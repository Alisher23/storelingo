export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export interface LoggerOptions {
  verbose: boolean;
  secrets: (string | undefined)[];
  out: (line: string) => void;
  err: (line: string) => void;
}

const MIN_SECRET_LENGTH = 6;

export function createLogger(opts: LoggerOptions): Logger {
  const secrets = opts.secrets.filter(
    (s): s is string => typeof s === "string" && s.length >= MIN_SECRET_LENGTH,
  );
  const mask = (msg: string): string =>
    secrets.reduce((acc, secret) => acc.split(secret).join("***"), msg);

  return {
    info: (msg) => opts.out(mask(msg)),
    warn: (msg) => opts.err(mask(`warning: ${msg}`)),
    error: (msg) => opts.err(mask(`error: ${msg}`)),
    debug: (msg) => {
      if (opts.verbose) opts.out(mask(`debug: ${msg}`));
    },
  };
}

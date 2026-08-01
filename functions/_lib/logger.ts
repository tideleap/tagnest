/**
 * Structured logger — the single observability primitive for TagNest.
 *
 * Every line is emitted as a single JSON string prefixed with `[tagnest]` so it
 * survives the Cloudflare Logs pipeline intact and can be grepped/queried:
 *
 *   [tagnest] {"ts":"2026-08-01T14:00:00.000Z","level":"info","event":"request","rid":"…","props":{…}}
 *
 * It deliberately has no external dependency: on Cloudflare the runtime binds
 * `console` to Logpush/Workers Logs, so JSON lines here become queryable
 * telemetry without any third-party agent.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(event: string, props?: Record<string, unknown>): void;
  info(event: string, props?: Record<string, unknown>): void;
  warn(event: string, props?: Record<string, unknown>): void;
  /** Logs at error level; `err` is flattened to `error`/`stack` fields. */
  error(event: string, err?: unknown, props?: Record<string, unknown>): void;
}

/** Anything with a LOG_LEVEL string satisfies this; `Env` is structural. */
export interface LoggerEnv {
  LOG_LEVEL?: string;
}

export function createLogger(env: LoggerEnv = {}, rid?: string): Logger {
  const configured = env.LOG_LEVEL as LogLevel | undefined;
  const threshold = configured && ORDER[configured] !== undefined ? ORDER[configured] : ORDER.info;

  const emit = (level: LogLevel, event: string, props?: Record<string, unknown>) => {
    if (ORDER[level] < threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      event,
      ...(rid ? { rid } : {}),
      ...(props ? { props } : {}),
    };
    (level === 'error' ? console.error : console.log)('[tagnest]', JSON.stringify(line));
  };

  return {
    debug: (event, props) => emit('debug', event, props),
    info: (event, props) => emit('info', event, props),
    warn: (event, props) => emit('warn', event, props),
    error: (event, err, props) => {
      const errProps: Record<string, unknown> =
        err == null
          ? {}
          : err instanceof Error
            ? { error: err.message, ...(err.stack ? { stack: err.stack } : {}) }
            : { error: String(err) };
      emit('error', event, { ...errProps, ...(props ?? {}) });
    },
  };
}

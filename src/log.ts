/**
 * A tiny structured logger, emitting one JSON line per event to stdout.
 *
 * The shape is deliberately pino-compatible (numeric `level`, epoch `time`, `msg`, and any extra
 * fields spread at the top level) so pino's log tooling can read it, but it is written against nothing but `console` (and, for the ward's label, tenant.ts's `AsyncLocalStorage`, which Workers' `nodejs_compat` has) —
 * because the same code has to run on Cloudflare Workers, where `process`/`os` aren't the right
 * source of truth and `console.log` is what reaches the log stream.
 */

import { tenantIfAny } from './tenant.js';

export type LogFn = {
  (obj: unknown, msg?: string): void;
  (msg: string): void;
};

export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

/** pino's numeric levels, so downstream parsing/filtering is unchanged. */
const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 } as const;

/** Serialize an Error the way pino does, so a stack still survives into the log line. */
function serializeError(err: Error): Record<string, unknown> {
  return { err: { type: err.name, message: err.message, stack: err.stack } };
}

function fields(objOrMsg: unknown): Record<string, unknown> {
  if (objOrMsg instanceof Error) return serializeError(objOrMsg);
  if (objOrMsg && typeof objOrMsg === 'object') return objOrMsg as Record<string, unknown>;
  return {};
}

function emit(level: number, a: unknown, b?: string): void {
  const msg = typeof a === 'string' ? a : b;
  const line: Record<string, unknown> = {
    level,
    time: Date.now(),
    // Which ward, on the many-ward host: every ward logs through this one logger, and a line that
    // says "push delivery did not succeed" is no use to the operator without it (tenant.ts).
    ...tenantIfAny()?.label,
    ...(typeof a === 'string' ? {} : fields(a)),
  };
  if (msg !== undefined) line.msg = msg;
  // JSON.stringify can throw on a circular payload; never let logging take a request down.
  let text: string;
  try {
    text = JSON.stringify(line);
  } catch {
    text = JSON.stringify({ level, time: Date.now(), msg: msg ?? '[unserializable log payload]' });
  }
  if (level >= LEVELS.error) console.error(text);
  else console.log(text);
}

function fn(level: number): LogFn {
  return ((a: unknown, b?: string) => emit(level, a, b)) as LogFn;
}

export const logger: Logger = {
  debug: fn(LEVELS.debug),
  info: fn(LEVELS.info),
  warn: fn(LEVELS.warn),
  error: fn(LEVELS.error),
};

/**
 * Redact the member access code from a URL before it reaches a log line. The shared gate secret
 * rides in `?code=` on an installed app's cold launch, and it must never land in request logs.
 */
export function redactUrl(url: string): string {
  return url.replace(/([?&]code=)[^&]*/g, '$1[redacted]');
}

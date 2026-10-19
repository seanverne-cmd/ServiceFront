import { env } from "@/lib/env";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const REDACT_KEYS = /(pass(word)?|secret|token|api[_-]?key|authorization|cookie|session|dsn|database_url|email|phone)/i;

/**
 * Structured JSON logger for server code. Two guarantees:
 *  1. values under secret-ish keys are replaced with "[redacted]"
 *  2. PII-ish keys (email/phone) are redacted too, so logs stay free of customer data.
 * Never log full exception objects (they can embed connection strings): use errorMessage().
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth-limit]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return "UnknownError";
}

function emit(level: LogLevel, message: string, fields: Record<string, unknown> = {}) {
  const min = env().LOG_LEVEL;
  if (LEVELS[level] < LEVELS[min]) return;
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    service: "servicefront",
    message,
    ...(redact(fields) as Record<string, unknown>),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};

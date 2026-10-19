import { z } from "zod";

/**
 * Server-only environment access. Never import this from a client component:
 * DATABASE_URL / LLM_API_KEY must never reach the browser bundle.
 */
if (typeof window !== "undefined") {
  throw new Error("lib/env.ts is server-only and must never be imported into a Client Component.");
}

const boolFromString = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : v.toLowerCase() === "true" || v === "1"));

function looksLikePostgresUrl(url: string) {
  return /^postgres(ql)?:\/\//.test(url);
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z
    .string()
    .optional()
    .refine((v) => v === undefined || looksLikePostgresUrl(v), "DATABASE_URL must be a postgres:// URL"),
  /** Migrations/seed only. This role bypasses RLS. Never expose it to the app runtime. */
  MIGRATION_DATABASE_URL: z.string().optional(),
  /** Signs dashboard session cookies / widget visitor tokens. Server-only. */
  SESSION_SECRET: z.string().optional(),
  /** Public origin of the site hosting the embeddable widget (used for CORS + link building). */
  PUBLIC_WIDGET_ORIGIN: z.string().default("http://localhost:3100"),
  DEMO_MODE: boolFromString(true),
  LLM_PROVIDER: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).catch("info"),
});

export type AppEnv = z.infer<typeof schema>;

let cached: AppEnv | null = null;

export function env(): AppEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Details stay server-side; the caller logs them. No secrets are echoed.
    throw new Error("Invalid environment configuration: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  }
  cached = parsed.data;
  return cached;
}

export function requireDatabaseUrl(): string {
  const url = env().DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  return url;
}

export function requireSessionSecret(): string {
  const secret = env().SESSION_SECRET;
  if (secret && secret.length >= 16) return secret;
  if (env().NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set (>=16 chars) in production.");
  }
  // Development only: an ephemeral, in-process placeholder. Sessions break on restart, which is fine locally.
  return "dev-only-insecure-session-secret";
}

/** True when a live LLM provider is configured. When false the app must run in labelled demo mode. */
export function llmConfigured(): boolean {
  const e = env();
  return Boolean(e.LLM_PROVIDER && e.LLM_API_KEY && !e.DEMO_MODE);
}

import { NextResponse } from "next/server";
import { getHealthSnapshot } from "@/lib/db";
import { env, llmConfigured } from "@/lib/env";
import { sessionCookieSecure } from "@/lib/auth/session";
import { logger, errorMessage } from "@/lib/logger";
import { healthQuerySchema } from "@/lib/validation";

/**
 * GET /api/health — a real, database-backed status check.
 *
 * Deliberately sanitized: aggregate counts only (no tenant names, no contact details, no keys),
 * and failures return a generic message so nothing about the database internals reaches a client.
 * The full error is written to the server log with secrets redacted.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const startedAt = Date.now();
  const url = new URL(request.url);

  const query = healthQuerySchema.safeParse({
    verbose: url.searchParams.get("verbose") ?? undefined,
  });
  if (!query.success) {
    logger.warn("health check rejected", { reason: "invalid_query" });
    return NextResponse.json({ status: "error", message: "invalid query parameters" }, { status: 400 });
  }

  const configuration = {
    demoMode: env().DEMO_MODE,
    llmConfigured: llmConfigured(),
    // Names only. Never the key itself, and never the connection string.
    llmProvider: env().DEMO_MODE ? null : (env().LLM_PROVIDER ?? null),
    // Lets test:auth assert the real cookie policy of the mode it is talking to, instead of
    // assuming one. A boolean, never a secret.
    nodeEnv: env().NODE_ENV,
    sessionCookieSecure: sessionCookieSecure(),
  };

  try {
    const snapshot = await getHealthSnapshot();
    const body = {
      status: "ok",
      service: "servicefront",
      database: {
        connected: true,
        schemaVersion: snapshot.schemaVersion,
        migrationsApplied: snapshot.migrationsApplied,
        publicTables: snapshot.publicTables,
        tablesWithRls: snapshot.rlsEnabledTables,
        tenants: snapshot.tenants,
        syntheticTenants: snapshot.tenantsSynthetic,
      },
      configuration,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
    };
    logger.info("health check ok", {
      schemaVersion: snapshot.schemaVersion,
      tenants: snapshot.tenants,
      latencyMs: body.latencyMs,
      demoMode: configuration.demoMode,
    });
    return NextResponse.json(body, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (err) {
    logger.error("health check failed", { detail: errorMessage(err), latencyMs: Date.now() - startedAt });
    return NextResponse.json(
      {
        status: "degraded",
        service: "servicefront",
        database: { connected: false },
        configuration,
        checkedAt: new Date().toISOString(),
        message: "The database is not reachable right now.",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

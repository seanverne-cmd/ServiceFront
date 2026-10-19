import postgres from "postgres";
import { requireDatabaseUrl } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * The one and only Postgres connection pool. Nothing outside src/lib/db/** may import
 * `postgres` — that is what keeps the tenancy context from being forgotten.
 * The connection string is read from the server environment and is never sent to the browser.
 */
if (typeof window !== "undefined") {
  throw new Error("src/lib/db is server-only: refusing to create a database client in the browser.");
}

let client: postgres.Sql | null = null;

export function getSql(): postgres.Sql {
  if (!client) {
    client = postgres(requireDatabaseUrl(), {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      // Never let a driver notice or an error object reach the log with connection details in it.
      onnotice: () => {},
    });
    logger.debug("database pool created");
  }
  return client;
}

/** Used by scripts and tests so the process can exit cleanly. */
export async function closeSql(): Promise<void> {
  if (client) {
    await client.end({ timeout: 5 });
    client = null;
  }
}

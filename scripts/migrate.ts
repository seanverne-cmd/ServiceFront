import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

/**
 * Migration runner: applies db/migrations/*.sql in filename order, each inside its own
 * transaction, recording what ran in public.schema_migrations.
 *
 * Uses MIGRATION_DATABASE_URL (the schema owner role). That role can bypass RLS, which is
 * exactly what creating tables and policies requires; the application runtime never uses it.
 */

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL is not set. Copy .env.example to .env and run scripts/bootstrap-db.sh first.");
  process.exit(1);
}

const dir = join(import.meta.dir, "..", "db", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
if (files.length === 0) {
  console.error(`No .sql migrations found in ${dir}`);
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  await sql`
    create table if not exists public.schema_migrations (
      version text primary key,
      checksum text not null,
      applied_at timestamptz not null default now(),
      took_ms integer not null default 0
    )`;

  const applied = new Set(
    (await sql`select version from public.schema_migrations`).map((r) => r.version as string),
  );

  let count = 0;
  for (const file of files) {
    const body = readFileSync(join(dir, file), "utf8");
    const checksum = new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 16);
    if (applied.has(file)) {
      const [row] = await sql`select checksum from public.schema_migrations where version = ${file}`;
      if (row && row.checksum !== checksum) {
        console.error(`migration ${file} has changed since it was applied (checksum mismatch) — refusing to continue`);
        process.exit(1);
      }
      console.log(`= ${file} (already applied)`);
      continue;
    }
    const started = Date.now();
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into public.schema_migrations (version, checksum, took_ms) values (${file}, ${checksum}, ${Date.now() - started})`;
    });
    console.log(`+ ${file} (${Date.now() - started}ms)`);
    count += 1;
  }

  const [{ count: tables }] = await sql`
    select count(*)::int as count from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'`;
  console.log(`migrations applied: ${count}; public base tables now: ${tables}`);
} catch (err) {
  // Print the driver's message (SQL-level, no credentials) but never the connection string.
  console.error(`migration failed: ${err instanceof Error ? err.message : "unknown error"}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}

import postgres from "postgres";

/**
 * Drops and rebuilds the public schema, then re-runs migrations and the seed.
 * Destructive: development/demo databases only. Never point this at production data.
 */
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL is not set. See docs/RUNBOOK.md.");
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await sql.unsafe(`drop schema if exists public cascade`);
  await sql.unsafe(`create schema public`);
  await sql.unsafe(`alter schema public owner to current_user`);
  console.log("public schema dropped and recreated");
} finally {
  await sql.end({ timeout: 5 });
}

for (const script of ["scripts/migrate.ts", "scripts/seed.ts"]) {
  const proc = Bun.spawnSync(["bun", "run", script], { stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) {
    console.error(`${script} failed during reset`);
    process.exit(proc.exitCode ?? 1);
  }
}
console.log("reset complete");

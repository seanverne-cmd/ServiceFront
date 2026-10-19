import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getHealthSnapshot } from "@/lib/db";
import { env } from "@/lib/env";
import { errorMessage } from "@/lib/logger";

/**
 * Minimal shell page: it exists to prove the app boots and that server-side database access
 * works through the data-access module. Dashboard UI is a later phase.
 * Rendered on the server, so the numbers below come straight from Postgres.
 */
export const dynamic = "force-dynamic";

export default async function HomePage() {
  let db: { ok: true; value: Awaited<ReturnType<typeof getHealthSnapshot>> } | { ok: false; reason: string };
  try {
    db = { ok: true, value: await getHealthSnapshot() };
  } catch (err) {
    db = { ok: false, reason: errorMessage(err) };
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">ServiceFront</h1>
        <p className="text-muted-foreground">
          Multi-business AI website receptionist — Phase 1 foundation (database, tenancy and RLS).
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Application status</CardTitle>
          <CardDescription>This page renders on the server and reads from Postgres.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <Row label="App" value="running" />
          <Row label="AI response mode" value={env().DEMO_MODE ? "demo (deterministic, labelled)" : "live provider configured"} />
          <Row label="Widget origin" value={env().PUBLIC_WIDGET_ORIGIN} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Database</CardTitle>
          <CardDescription>Aggregate counts only — no tenant records are shown here.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {db.ok ? (
            <>
              <Row label="Connected" value="yes" />
              <Row label="Schema version" value={String(db.value.schemaVersion ?? "none")} />
              <Row label="Migrations applied" value={String(db.value.migrationsApplied)} />
              <Row label="Public tables" value={`${db.value.publicTables} (${db.value.rlsEnabledTables} with row level security)`} />
              <Row label="Tenants" value={`${db.value.tenants} (${db.value.tenantsSynthetic} synthetic demo)`} />
            </>
          ) : (
            <Row label="Connected" value="no — check DATABASE_URL and that migrations have been applied" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Check it yourself</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm text-muted-foreground">
          <code>/api/health</code>
          <code>bun run db:migrate &amp;&amp; bun run db:seed &amp;&amp; bun run test:isolation</code>
        </CardContent>
      </Card>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border pb-1 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

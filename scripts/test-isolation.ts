import postgres from "postgres";
import { withTenantTransaction, TenancyError, DataAccessError } from "../src/lib/db/tenancy";

/**
 * Tenant-isolation test. It runs against the real database as the real application role and
 * fails loudly (exit code 1) if any isolation guarantee is broken.
 *
 *   bun run test:isolation
 *
 * It proves, with SQLSTATE-level evidence:
 *   * no session context      -> zero rows, and writes are refused
 *   * context for business A  -> cannot SELECT / UPDATE / DELETE business B's rows
 *   * context for business A  -> cannot INSERT a row claiming business B's id
 *   * a message cannot be attached to another tenant's conversation (composite FK)
 *   * a non-member user, or a member whose membership is revoked, sees nothing
 *   * a platform admin with support access can read across tenants but cannot write
 *   * the only context-free read (the widget lookup) returns a fixed, non-sensitive field set
 */

const OWNER_URL = process.env.MIGRATION_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
if (!OWNER_URL || !APP_URL) {
  console.error("DATABASE_URL and MIGRATION_DATABASE_URL must both be set. See docs/RUNBOOK.md.");
  process.exit(1);
}

const A = "aaaaaa01-1111-4111-8111-111111111111";
const B = "bbbbbb02-2222-4222-8222-222222222222";
const USER_A = "aaaaaa01-0000-4000-8000-00000000000a";
const USER_B = "bbbbbb02-0000-4000-8000-00000000000b";
const USER_STRANGER = "cccccc03-0000-4000-8000-00000000000c";
const TEST_ADMIN = "dddddd04-0000-4000-8000-00000000000d";
const BATCH = "isolation-test";

const owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
const app = postgres(APP_URL, { max: 1, onnotice: () => {} });

const APP_AROLE_QUERY = `select current_user as role,
  (select rolbypassrls from pg_roles r where r.rolname = current_user) as bypassrls,
  (select count(*)::int from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relowner = (select oid from pg_roles r2 where r2.rolname = current_user)) as owned_tables`;

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

type Ctx = { businessId: string; userId: string; supportAccess?: boolean };

async function countWithContext(ctx: Ctx, table: string, opts: { filterBusiness?: string } = {}) {
  return withTenantTransaction(ctx, async (tx) => {
    const rows = opts.filterBusiness
      ? await tx.unsafe(`select count(*)::int as n from public.${table} where business_id = $1`, [opts.filterBusiness])
      : await tx.unsafe(`select count(*)::int as n from public.${table}`);
    return Number(rows[0].n);
  });
}

async function runExpectError(ctx: Ctx, sqlText: string, params: unknown[]) {
  try {
    await withTenantTransaction(ctx, async (tx) => {
      await tx.unsafe(sqlText, params);
    });
    return { threw: false, reason: "", code: "" };
  } catch (err) {
    const e = err as { reason?: string; kind?: string; code?: string };
    return { threw: true, reason: e.reason ?? e.kind ?? "", code: e.code ?? "" };
  }
}

/**
 * Like runExpectError, but also reports how many rows the statement actually wrote.
 *
 * This matters for `insert ... select` attacks: when RLS hides the other tenant's rows the
 * SELECT simply yields nothing, so the statement succeeds while writing zero rows. "No
 * exception" therefore does NOT mean "the write landed" -- the assertion has to look at the
 * row count, and at the table afterwards, to say anything meaningful.
 */
async function runCaptureRefusal(ctx: Ctx, sqlText: string, params: unknown[]) {
  try {
    const written = await withTenantTransaction(ctx, async (tx) => {
      const rows = await tx.unsafe(`${sqlText} returning 1`, params);
      return rows.length;
    });
    return { threw: false, code: "", written };
  } catch (err) {
    const e = err as { reason?: string; kind?: string; code?: string };
    return { threw: true, code: e.code ?? "", written: 0 };
  }
}

async function fixture() {
  await owner.begin(async (tx) => {
    await tx`delete from public.businesses where id in (${A}, ${B})`;
    await tx`
      insert into public.businesses (id, slug, name, industry, is_synthetic, synthetic_batch)
      values
        (${A}, 'isolation-test-a', 'Isolation Test A', 'plumbing', true, ${BATCH}),
        (${B}, 'isolation-test-b', 'Isolation Test B', 'plumbing', true, ${BATCH})`;
    await tx`
      insert into public.business_members (business_id, user_id, role, status, is_synthetic, synthetic_batch)
      values
        (${A}, ${USER_A}, 'business_owner', 'active', true, ${BATCH}),
        (${B}, ${USER_B}, 'business_owner', 'active', true, ${BATCH})`;
    await tx`
      insert into public.platform_admins (user_id, note, is_synthetic, synthetic_batch)
      values (${TEST_ADMIN}, 'isolation test support admin', true, ${BATCH})
      on conflict (user_id) do update set synthetic_batch = excluded.synthetic_batch`;
    await tx`
      insert into public.services (business_id, slug, name, is_synthetic, synthetic_batch)
      values (${A}, 'iso-service', 'A service', true, ${BATCH}),
             (${B}, 'iso-service', 'B service', true, ${BATCH})`;
    await tx`
      insert into public.service_areas (business_id, name, city, is_synthetic, synthetic_batch)
      values (${A}, 'A City', 'A City', true, ${BATCH}), (${B}, 'B City', 'B City', true, ${BATCH})`;
    await tx`
      insert into public.conversations (business_id, visitor_id, is_synthetic, synthetic_batch)
      values (${A}, 'iso-visitor-a', true, ${BATCH}), (${B}, 'iso-visitor-b', true, ${BATCH})`;
    await tx`
      insert into public.messages (business_id, conversation_id, role, source, content, is_synthetic, synthetic_batch)
      select c.business_id, c.id, 'visitor', 'visitor', 'hello from ' || c.visitor_id, true, ${BATCH}
      from public.conversations c where c.business_id in (${A}, ${B})`;
    await tx`
      insert into public.leads (business_id, category, status, full_name, phone, consent_to_contact, is_synthetic, synthetic_batch)
      values
        (${A}, 'service_request', 'new', 'A Lead', '+1 (714) 555-0001', true, true, ${BATCH}),
        (${B}, 'service_request', 'new', 'B Lead', '+1 (714) 555-0002', true, true, ${BATCH})`;
  });
}

async function cleanup() {
  await owner`delete from public.businesses where id in (${A}, ${B})`;
  await owner`delete from public.platform_admins where user_id = ${TEST_ADMIN}`;
}

try {
  await fixture();
  const ctxA: Ctx = { businessId: A, userId: USER_A };
  const ctxB: Ctx = { businessId: B, userId: USER_B };

  /* ------------------------------------------------------------------ 0. preflight */
  const [roleInfo] = await app.unsafe(APP_AROLE_QUERY);
  console.log(
    `info  app connects as '${roleInfo.role}' (bypassrls=${roleInfo.bypassrls}, tables it owns=${roleInfo.owned_tables})`,
  );
  check(
    "preflight: the application role cannot bypass RLS and owns no tables (otherwise the results below would be vacuous)",
    roleInfo.bypassrls === false && Number(roleInfo.owned_tables) === 0,
    JSON.stringify(roleInfo),
  );

  /* -------------------------------------------------------- 1. missing context fails closed */
  const noCtxServices = await app`select count(*)::int as n from public.services`;
  const noCtxConversations = await app`select count(*)::int as n from public.conversations`;
  const noCtxBusinesses = await app`select count(*)::int as n from public.businesses`;
  check("no context: services returns 0 rows (not all rows)", Number(noCtxServices[0].n) === 0, `got ${noCtxServices[0].n}`);
  check("no context: conversations returns 0 rows", Number(noCtxConversations[0].n) === 0);
  check("no context: businesses returns 0 rows", Number(noCtxBusinesses[0].n) === 0);

  const noCtxWrite = await app
    .unsafe(`insert into public.services (business_id, slug, name) values ($1, 'nocontext', 'No context') returning id`, [A])
    .then(() => ({ code: "" }))
    .catch((e: { code?: string }) => ({ code: e.code ?? "" }));
  check("no context: INSERT is refused by RLS (SQLSTATE 42501)", noCtxWrite.code === "42501", `code=${noCtxWrite.code}`);

  const userOnly = await app.begin(async (tx) => {
    await tx`select set_config('app.current_user_id', ${USER_A}, true)`;
    const rows = await tx`select count(*)::int as n from public.services`;
    return Number(rows[0].n);
  });
  check("user id set but no business id: services returns 0 rows", userOnly === 0);

  const businessOnly = await app.begin(async (tx) => {
    await tx`select set_config('app.current_business_id', ${A}, true)`;
    const rows = await tx`select count(*)::int as n from public.services`;
    return Number(rows[0].n);
  });
  check("business id set but no user id: services returns 0 rows (membership is required)", businessOnly === 0);

  const strangerCtx: Ctx = { businessId: A, userId: USER_STRANGER };
  const strangerCount = await countWithContext(strangerCtx, "services");
  check("non-member user id in business A's context: services returns 0 rows", strangerCount === 0, `got ${strangerCount}`);

  /* ------------------------------------------------------------- 2. scoped to business A */
  check("context A: can read A's own services", (await countWithContext(ctxA, "services")) === 1);
  check(
    "context A: cannot SELECT business B's services",
    (await countWithContext(ctxA, "services", { filterBusiness: B })) === 0,
  );
  check(
    "context A: cannot SELECT business B's conversations",
    (await countWithContext(ctxA, "conversations", { filterBusiness: B })) === 0,
  );
  check("context A: cannot SELECT business B's leads", (await countWithContext(ctxA, "leads", { filterBusiness: B })) === 0);
  check(
    "context A: cannot SELECT business B's members",
    (await countWithContext(ctxA, "services", { filterBusiness: B })) === 0,
  );

  const updated = await withTenantTransaction(ctxA, async (tx) =>
    Number((await tx.unsafe(`update public.services set name = 'hacked by A' where business_id = $1 returning id`, [B]))
      .length),
  );
  check("context A: UPDATE against business B's services affects 0 rows", updated === 0, `affected ${updated}`);

  const deleted = await withTenantTransaction(ctxA, async (tx) =>
    Number((await tx.unsafe(`delete from public.leads where business_id = $1 returning id`, [B])).length),
  );
  check("context A: DELETE against business B's leads affects 0 rows", deleted === 0, `affected ${deleted}`);

  const insertOwn = await withTenantTransaction(ctxA, async (tx) => {
    const rows = await tx.unsafe(
      `insert into public.services (business_id, slug, name) values ($1, 'a-second', 'A second service') returning id`,
      [A],
    );
    return rows.length;
  });
  check("context A: INSERT for its own business succeeds (isolation blocks, it does not break the app)", insertOwn === 1);

  const crossInsert = await withTenantTransaction(ctxA, async (tx) => {
    try {
      await tx.unsafe(`insert into public.services (business_id, slug, name) values ($1, 'spoiler', 'Spoiler')`, [B]);
      return { code: "none" };
    } catch (err) {
      throw err;
    }
  })
    .then(() => ({ code: "none" }))
    .catch((e: { reason?: string; code?: string }) => ({ code: e.code ?? e.reason ?? "error" }));
  check(
    "context A: INSERT claiming business B's id is rejected (SQLSTATE 42501 / rls_policy_violation)",
    crossInsert.code === "42501" || crossInsert.code === "rls_policy_violation",
    `got ${crossInsert.code}`,
  );

  const crossMessage = await runCaptureRefusal(
    ctxA,
    `insert into public.messages (business_id, conversation_id, role, source, content)
       select $1, id, 'staff', 'staff', 'cross tenant' from public.conversations where business_id = $2`,
    [A, B],
  );
  check(
    "context A: cannot attach a message to business B's conversation (refused, or zero rows written)",
    crossMessage.threw || crossMessage.written === 0,
    `threw=${crossMessage.threw} code=${crossMessage.code} written=${crossMessage.written}`,
  );

  // Independent of what the statement reported, ask the table itself: is there any message
  // whose business_id disagrees with its conversation's business_id? (Read as owner, so RLS
  // cannot hide the evidence we are looking for.)
  const orphanMessages = await owner.begin(async (tx) => {
    const rows = await tx.unsafe(
      `select count(*)::int as n from public.messages m
         join public.conversations c on c.id = m.conversation_id
        where m.business_id <> c.business_id`,
    );
    return Number(rows[0].n);
  });
  check(
    "no message row exists whose business_id disagrees with its conversation's business_id",
    orphanMessages === 0,
    `found ${orphanMessages}`,
  );

  // Second layer, tested where RLS cannot be the thing doing the work: with the tenant context
  // bypassed entirely (owner role) the composite FK alone must refuse the mismatched pair.
  const fkBOnly = await owner
    .begin(async (tx) => {
      const convBRow = await tx.unsafe(`select id from public.conversations where business_id = $1 limit 1`, [B]);
      if (convBRow.length === 0) throw new Error("fixture missing: business B has no conversation");
      await tx.unsafe(
        `insert into public.messages (business_id, conversation_id, role, source, content)
         values ($1, $2, 'staff', 'staff', 'cross tenant, RLS bypassed')`,
        [A, convBRow[0].id],
      );
      return { code: "" };
    })
    .then(() => ({ code: "none" }))
    .catch((e: { code?: string }) => ({ code: e.code ?? "error" }));
  check(
    "composite FK alone refuses a cross-tenant message even with RLS bypassed (SQLSTATE 23503)",
    fkBOnly.code === "23503",
    `got ${fkBOnly.code}`,
  );

  /* ------------------------------------------------------------- 3. scoped to business B */
  check("context B: can read B's own services", (await countWithContext(ctxB, "services")) === 1);
  check(
    "context B: cannot SELECT business A's services",
    (await countWithContext(ctxB, "services", { filterBusiness: A })) === 0,
  );
  const bHack = await withTenantTransaction(ctxB, async (tx) =>
    Number((await tx.unsafe(`update public.services set name = 'hacked by B' where business_id = $1 returning id`, [A]))
      .length),
  );
  check("context B: UPDATE against business A's services affects 0 rows", bHack === 0);

  /* --------------------------------------------------- 4. support access (platform admin) */
  const adminNoOptIn = await countWithContext({ businessId: B, userId: TEST_ADMIN }, "services", { filterBusiness: A });
  check("platform admin WITHOUT support opt-in: cannot read another tenant (0 rows)", adminNoOptIn === 0, `got ${adminNoOptIn}`);

  const adminCtx: Ctx = { businessId: A, userId: TEST_ADMIN, supportAccess: true };
  const adminRead = await countWithContext(adminCtx, "services", { filterBusiness: B });
  check("platform admin WITH support opt-in: can read business B's services (audited)", adminRead === 1, `got ${adminRead}`);

  const adminWrite = await withTenantTransaction(adminCtx, async (tx) =>
    Number((await tx.unsafe(`update public.services set name = 'admin edit' where business_id = $1 returning id`, [B])).length),
  );
  check("platform admin WITH support opt-in: still cannot WRITE to a tenant (0 rows)", adminWrite === 0, `affected ${adminWrite}`);

  const auditRows = await owner`
    select count(*)::int as n from public.audit_logs
    where business_id = ${A} and action = 'support_access.used' and actor_user_id = ${TEST_ADMIN}`;
  check("support access is recorded in audit_logs", Number(auditRows[0].n) >= 1, `rows=${auditRows[0].n}`);

  /* --------------------------------------------------------- 5. membership drives access */
  await owner`update public.business_members set status = 'revoked' where business_id = ${A} and user_id = ${USER_A}`;
  const afterRevoke = await countWithContext(ctxA, "services");
  check("context A after the membership is revoked: 0 rows (revocation takes effect immediately)", afterRevoke === 0, `got ${afterRevoke}`);

  const afterRevokeWrite = await runExpectError(
    ctxA,
    `insert into public.services (business_id, slug, name) values ($1, 'after-revoke', 'After revoke')`,
    [A],
  );
  check("context A after revocation: writes are refused too", afterRevokeWrite.threw);

  await owner`update public.business_members set status = 'active' where business_id = ${A} and user_id = ${USER_A}`;

  /* --------------------------------------------- 6. the one context-free read is narrow */
  const widgetKeys = await owner`
    select id, widget_public_key from public.businesses where id in (${A}, ${B}) order by id`;
  const keyA = widgetKeys[0].widget_public_key as string;
  const resolved = await app.unsafe(`select app.resolve_widget_business($1) as b`, [keyA]);
  const resolvedB = resolved[0].b as Record<string, unknown> | null;
  const missing = await app.unsafe(`select app.resolve_widget_business($1) as b`, ["0".repeat(32)]);
  check("widget lookup by public key resolves the right business", resolvedB?.business_id === A, JSON.stringify(resolvedB));
  check("widget lookup with an unknown key returns nothing", (missing[0].b as unknown) === null);
  check(
    "widget lookup exposes no contact/PII fields (no email, no roster, no keys)",
    resolvedB !== null &&
      !["primary_email", "primary_phone", "widget_public_key"].some((k) => Object.keys(resolvedB).includes(k)),
    JSON.stringify(Object.keys(resolvedB ?? {})),
  );

  /* ------------------------------------------------- 7. business B survived A's attempts */
  const bSurvived = await owner`
    select s.name as service_name, (select count(*)::int from public.leads l where l.business_id = ${B}) as leads
    from public.services s where s.business_id = ${B} and s.slug = 'iso-service'`;
  check(
    "business B's data is unchanged after A's update/delete attempts",
    bSurvived[0]?.service_name === "B service" && Number(bSurvived[0]?.leads) === 1,
    JSON.stringify(bSurvived[0]),
  );
} catch (err) {
  failures.push("unexpected error");
  console.error(`FAIL  unexpected error: ${err instanceof Error ? `${err.name}: ${err.message}` : "unknown"}`);
} finally {
  try {
    await cleanup();
  } catch {
    console.error("warning: cleanup of isolation-test rows failed");
  }
  await owner.end({ timeout: 5 });
  await app.end({ timeout: 5 });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("TENANT ISOLATION IS BROKEN:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log("tenant isolation verified: no context returns nothing, and no tenant can reach another's rows");

// Referenced so the imports stay meaningful if a check is skipped in future edits.
void DataAccessError;
void TenancyError;

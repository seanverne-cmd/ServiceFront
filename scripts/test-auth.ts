import postgres from "postgres";
import { createHash } from "node:crypto";

/**
 * ============================================================================
 *  test:auth — end-to-end authentication and tenant-isolation proof
 * ============================================================================
 * This script drives the RUNNING app over HTTP (it never calls the data layer directly for the
 * checks themselves) and asserts:
 *
 *   1. an unauthenticated request to /dashboard redirects to sign-in;
 *   2. sign-in works for a documented synthetic account and sets an httpOnly, SameSite=Lax cookie;
 *   3. the plumbing owner sees plumbing data and CANNOT read or modify any Pacific Paws row;
 *   4. the vet owner sees vet data and cannot reach the plumbing tenant;
 *   5. staff can read the profile but a profile write is refused server-side (403) and nothing
 *      changes in the database;
 *   6. a member of both businesses can switch, and the switch re-verifies membership;
 *   7. an expired/revoked session, and a session pointing at a business the user is not a member
 *      of, are both refused.
 *
 * Requires: the app running (default http://127.0.0.1:3100) and `.env` with
 * MIGRATION_DATABASE_URL + DATABASE_URL. Exit code 0 only when every check passes.
 *
 *   bun run test:auth
 */

const BASE = (process.env.TEST_BASE_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const MIGRATION_URL = process.env.MIGRATION_DATABASE_URL;
if (!MIGRATION_URL) {
  console.error("MIGRATION_DATABASE_URL is not set. See docs/RUNBOOK.md.");
  process.exit(1);
}

const PLUMBING_ID = "11111111-1111-4111-8111-111111111111";
const VET_ID = "22222222-2222-4222-8222-222222222222";
const PLUMBING_NAME = "Pacific Coast Plumbing";
const VET_NAME = "Pacific Paws";

const ACCOUNTS = {
  plumbingOwner: { email: "owner@pacificcoastplumbing-demo.example", password: "Plumbing!Demo2026" },
  plumbingStaff: { email: "staff@pacificcoastplumbing-demo.example", password: "Staff!Demo2026" },
  vetOwner: { email: "owner@pacificpaws-demo.example", password: "Paws!Demo2026" },
  multi: { email: "multi@servicefront-demo.example", password: "Multi!Demo2026" },
};

/* ---------------------------------- harness ------------------------------- */

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail === undefined ? "" : `\n          got: ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
}

/**
 * Removes the layout's business switcher from a rendered dashboard: the server HTML
 * `<option>`s AND their duplicate inside the RSC flight payload. What is left is the page's own
 * content, which must be scoped to the active tenant only.
 */
function stripBusinessSwitcher(body: string): string {
  return body
    .replace(/<option\b[^>]*>[\s\S]*?<\/option>/g, "")
    .replace(/\\"option\\",\\"[0-9a-f-]{36}\\",\{[^}]*\}/g, "");
}
function section(title: string): void {
  console.log(`\n${title}`);
}

type Res = { status: number; location: string | null; body: string; setCookie: string[]; headers: Headers };

class Client {
  cookies = new Map<string, string>();
  label: string;
  constructor(label: string) {
    this.label = label;
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async request(
    path: string,
    opts: { method?: string; form?: Record<string, string>; origin?: boolean; headers?: Record<string, string> } = {},
  ): Promise<Res> {
    const method = opts.method ?? "GET";
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const cookie = this.cookieHeader();
    if (cookie) headers["cookie"] = cookie;
    let body: string | undefined;
    if (opts.form) {
      body = new URLSearchParams(opts.form).toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    if (opts.origin !== false) headers["origin"] = BASE;

    const res = await fetch(`${BASE}${path}`, { method, headers, body, redirect: "manual" });
    const setCookie = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const raw of setCookie) {
      const [pair] = raw.split(";");
      const idx = pair.indexOf("=");
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === "" || /max-age=0/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    return { status: res.status, location: res.headers.get("location"), body: text, setCookie, headers: res.headers };
  }

  get(path: string) {
    return this.request(path);
  }

  post(path: string, form: Record<string, string>) {
    return this.request(path, { method: "POST", form });
  }

  async signIn(account: { email: string; password: string }) {
    return this.post("/api/auth/sign-in", { email: account.email, password: account.password });
  }

  token(): string | null {
    return this.cookies.get("sf_session") ?? null;
  }
}

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const sql = postgres(MIGRATION_URL, { max: 1, onnotice: () => {} });

type ProfileRow = {
  name: string;
  industry: string;
  website_url: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  city: string | null;
  region: string | null;
  public_welcome_message: string | null;
  hours_summary: string | null;
};

async function readProfile(businessId: string): Promise<ProfileRow> {
  const [row] = await sql`select name, industry::text as industry, website_url, primary_email, primary_phone,
                                 city, region, public_welcome_message, hours_summary
                          from public.businesses where id = ${businessId}`;
  return row as ProfileRow;
}

function profileForm(p: ProfileRow, overrides: Partial<ProfileRow> = {}): Record<string, string> {
  const merged = { ...p, ...overrides };
  return {
    name: merged.name,
    industry: merged.industry,
    website_url: merged.website_url ?? "",
    primary_email: merged.primary_email ?? "",
    primary_phone: merged.primary_phone ?? "",
    city: merged.city ?? "",
    region: merged.region ?? "",
    public_welcome_message: merged.public_welcome_message ?? "",
    hours_summary: merged.hours_summary ?? "",
  };
}

function isRedirectTo(res: Res, pathPrefix: string): boolean {
  return [301, 302, 303, 307, 308].includes(res.status) && (res.location ?? "").includes(pathPrefix);
}

/* ----------------------------------- run ---------------------------------- */

const originalPlumbing = await readProfile(PLUMBING_ID);
let exitCode = 1;

try {
  console.log(`test:auth target ${BASE}`);

  /* -- 1. unauthenticated ------------------------------------------------ */
  section("1. Unauthenticated access");
  const anon = new Client("anon");
  const anonDash = await anon.get("/dashboard");
  check("GET /dashboard without a session redirects to /sign-in", isRedirectTo(anonDash, "/sign-in"), {
    status: anonDash.status,
    location: anonDash.location,
  });
  const anonApi = await anon.get("/api/dashboard/profile");
  check("GET /api/dashboard/profile without a session is 401", anonApi.status === 401, anonApi.status);
  const signInPage = await anon.get("/sign-in");
  check("GET /sign-in renders the sign-in form", signInPage.status === 200 && /Sign in/.test(signInPage.body), signInPage.status);

  const badPassword = await anon.signIn({ email: ACCOUNTS.plumbingOwner.email, password: "definitely-wrong" });
  check(
    "wrong password is refused with the generic message and no session cookie",
    isRedirectTo(badPassword, "/sign-in?error=invalid") && !badPassword.setCookie.some((c) => c.includes("sf_session=") && !c.includes("sf_session=;")),
    { status: badPassword.status, location: badPassword.location, cookies: badPassword.setCookie },
  );
  const unknownEmail = await anon.signIn({ email: "nobody@example.invalid", password: "definitely-wrong" });
  check(
    "unknown email gets the identical generic response (no account enumeration)",
    unknownEmail.location === badPassword.location && unknownEmail.status === badPassword.status,
    { known: badPassword.location, unknown: unknownEmail.location },
  );

  /* -- 2. plumbing owner ------------------------------------------------- */
  section("2. Plumbing owner: sign-in, own tenant, cross-tenant refusal");
  const owner = new Client("plumbing-owner");
  const ownerSignIn = await owner.signIn(ACCOUNTS.plumbingOwner);
  const sessionCookie = ownerSignIn.setCookie.find((c) => c.startsWith("sf_session=")) ?? "";
  check("plumbing owner signs in and is redirected to /dashboard", isRedirectTo(ownerSignIn, "/dashboard"), {
    status: ownerSignIn.status,
    location: ownerSignIn.location,
  });
  check("session cookie is HttpOnly", /httponly/i.test(sessionCookie), sessionCookie);
  check("session cookie is SameSite=Lax", /samesite=lax/i.test(sessionCookie), sessionCookie);
  // The Secure flag is a MODE-DEPENDENT policy, so assert the true behaviour of the mode the
  // server reports rather than one universal claim. /api/health publishes the policy that
  // src/lib/auth/session.ts (sessionCookieSecure) actually applied.
  const health = await anon.get("/api/health");
  const healthCfg = (JSON.parse(health.body || "{}") as { configuration?: Record<string, unknown> })
    .configuration ?? {};
  const serverSecure = healthCfg.sessionCookieSecure;
  const serverEnv = healthCfg.nodeEnv;
  check("health reports the server's cookie policy", typeof serverSecure === "boolean", healthCfg);
  check(
    "session cookie's Secure flag matches the policy the server applied",
    /;\s*secure/i.test(sessionCookie) === (serverSecure === true),
    { cookie: sessionCookie, policy: serverSecure, nodeEnv: serverEnv },
  );
  check(
    "a production server ALWAYS marks the session cookie Secure",
    serverEnv !== "production" || serverSecure === true,
    { nodeEnv: serverEnv, policy: serverSecure },
  );
  check(
    "local development over plain http keeps the flow working (no Secure, or a loopback host)",
    serverEnv === "production" ||
      !/;\s*secure/i.test(sessionCookie) ||
      /localhost|127\.0\.0\.1|\[::1\]/.test(BASE),
    { cookie: sessionCookie, base: BASE },
  );

  const ownerDash = await owner.get("/dashboard");
  check("GET /dashboard returns the plumbing dashboard", ownerDash.status === 200 && ownerDash.body.includes(PLUMBING_NAME));
  check("plumbing dashboard contains NO Pacific Paws data", !ownerDash.body.includes(VET_NAME), "found vet tenant name");
  const ownerApi = await owner.get("/api/dashboard/profile");
  const ownerApiJson = JSON.parse(ownerApi.body || "{}");
  check(
    "GET /api/dashboard/profile returns the plumbing business with owner role",
    ownerApi.status === 200 && ownerApiJson.active_business?.id === PLUMBING_ID && ownerApiJson.role === "business_owner",
    ownerApiJson,
  );

  const ownerSwitch = await owner.post("/api/auth/switch-business", { business_id: VET_ID });
  check("plumbing owner CANNOT switch the session to the veterinary tenant (403)", ownerSwitch.status === 403, ownerSwitch.status);
  const afterSwitch = await owner.get("/api/dashboard/profile");
  check("after the refused switch the session is still on plumbing", JSON.parse(afterSwitch.body).active_business?.id === PLUMBING_ID);

  const marker = "test:auth marker " + new Date().toISOString();
  const edit = await owner.post(
    "/api/dashboard/profile",
    profileForm(originalPlumbing, { public_welcome_message: marker, hours_summary: "Mon–Fri 7am–6pm, Sat 8am–4pm (edited by test:auth)" }),
  );
  check("owner can save the business profile", isRedirectTo(edit, "/dashboard/profile?status=saved"), {
    status: edit.status,
    location: edit.location,
  });
  const afterEdit = await owner.get("/dashboard");
  check("the edited welcome message is persisted and rendered from the database", afterEdit.body.includes(marker));
  const [auditRow] = await sql`
    select metadata from public.audit_logs
    where business_id = ${PLUMBING_ID} and action = 'business.updated'
    order by created_at desc limit 1`;
  const auditMeta = (auditRow?.metadata ?? {}) as { changed_fields?: string[] };
  check(
    "an audit_logs entry records the profile change (actor + changed fields, no secrets)",
    Array.isArray(auditMeta.changed_fields) && auditMeta.changed_fields.includes("public_welcome_message"),
    auditMeta,
  );
  const [signInAudit] = await sql`
    select count(*)::int as n from public.audit_logs
    where business_id = ${PLUMBING_ID} and action = 'auth.signed_in'`;
  check("a sign-in audit entry was written for the plumbing tenant", signInAudit.n > 0, signInAudit);

  // Restore the demo data so the demo stays repeatable.
  const restore = await owner.post("/api/dashboard/profile", profileForm(originalPlumbing));
  check("profile restored to the seeded values", isRedirectTo(restore, "/dashboard/profile?status=saved"));

  const ownerToken = owner.token();
  const signOut = await owner.post("/api/auth/sign-out", {});
  check("sign-out redirects to /sign-in", isRedirectTo(signOut, "/sign-in"), { status: signOut.status, location: signOut.location });
  const afterSignOut = await owner.get("/dashboard");
  check("after sign-out /dashboard redirects to sign-in", isRedirectTo(afterSignOut, "/sign-in"), afterSignOut.status);

  const replay = new Client("replay");
  if (ownerToken) replay.cookies.set("sf_session", ownerToken);
  const replayDash = await replay.get("/dashboard");
  check(
    "a copied cookie from a signed-out session is dead server-side (revocation)",
    isRedirectTo(replayDash, "/sign-in"),
    replayDash.status,
  );

  /* -- 3. vet owner ------------------------------------------------------ */
  section("3. Veterinary owner: own tenant, cross-tenant refusal");
  const vet = new Client("vet-owner");
  const vetSignIn = await vet.signIn(ACCOUNTS.vetOwner);
  check("vet owner signs in", isRedirectTo(vetSignIn, "/dashboard"), vetSignIn.location);
  const vetDash = await vet.get("/dashboard");
  check("vet dashboard shows Pacific Paws", vetDash.status === 200 && vetDash.body.includes(VET_NAME));
  check("vet dashboard contains NO plumbing data", !vetDash.body.includes(PLUMBING_NAME), "found plumbing tenant name");
  const vetApi = JSON.parse((await vet.get("/api/dashboard/profile")).body);
  check("vet session resolves to the veterinary business", vetApi.active_business?.id === VET_ID, vetApi.active_business);
  const vetSwitch = await vet.post("/api/auth/switch-business", { business_id: PLUMBING_ID });
  check("vet owner CANNOT switch to the plumbing tenant (403)", vetSwitch.status === 403, vetSwitch.status);

  /* -- 4. staff ---------------------------------------------------------- */
  section("4. Staff account: read-only configuration");
  const staff = new Client("plumbing-staff");
  const staffSignIn = await staff.signIn(ACCOUNTS.plumbingStaff);
  check("staff signs in", isRedirectTo(staffSignIn, "/dashboard"), staffSignIn.location);
  const staffDash = await staff.get("/dashboard");
  check("staff can read the plumbing dashboard", staffDash.status === 200 && staffDash.body.includes(PLUMBING_NAME));
  const staffApi = JSON.parse((await staff.get("/api/dashboard/profile")).body);
  check("staff session reports the business_staff role", staffApi.role === "business_staff" && staffApi.can_configure === false, staffApi);
  const staffEdit = await staff.post(
    "/api/dashboard/profile",
    profileForm(originalPlumbing, { name: "Hijacked By Staff Ltd" }),
  );
  check("staff profile edit is REFUSED server-side (403)", staffEdit.status === 403, staffEdit.status);
  const afterStaffEdit = await readProfile(PLUMBING_ID);
  check("no staff change reached the database", afterStaffEdit.name === originalPlumbing.name, afterStaffEdit.name);

  /* -- 5. multi-business ------------------------------------------------- */
  section("5. Member of both businesses: switching");
  const multi = new Client("multi");
  const multiSignIn = await multi.signIn(ACCOUNTS.multi);
  check("multi-business account signs in", isRedirectTo(multiSignIn, "/dashboard"), multiSignIn.location);
  const multiApi1 = JSON.parse((await multi.get("/api/dashboard/profile")).body);
  check("starts on plumbing as owner", multiApi1.active_business?.id === PLUMBING_ID && multiApi1.role === "business_owner", multiApi1);
  const multiSwitch = await multi.post("/api/auth/switch-business", { business_id: VET_ID });
  check("can switch to the veterinary tenant", isRedirectTo(multiSwitch, "/dashboard"), multiSwitch.location);
  const multiApi2 = JSON.parse((await multi.get("/api/dashboard/profile")).body);
  check(
    "after the switch the session is on the vet business as staff",
    multiApi2.active_business?.id === VET_ID && multiApi2.role === "business_staff",
    multiApi2,
  );
  const multiDash = await multi.get("/dashboard");
  // The dashboard layout renders a business switcher listing EVERY membership the user has, so
  // both names legitimately appear in the page. What must be true is that the page's own content
  // is the ACTIVE (vet) tenant and the plumbing business appears only as a switch-back option.
  const switcher = multiDash.body.match(/<select[^>]*aria-label="Active business"[\s\S]*?<\/select>/)?.[0] ?? "";
  check("switched dashboard renders the vet tenant's own data", multiDash.status === 200 && multiDash.body.includes(VET_NAME), {
    status: multiDash.status,
  });
  check("the business switcher still offers a route back to the plumbing tenant", switcher.includes(PLUMBING_ID), switcher.slice(0, 400));
  check("the switcher has the vet tenant selected, i.e. the switch took effect in the page", new RegExp(`<option value="${VET_ID}"[^>]*selected`).test(switcher), switcher.slice(0, 400));
  check(
    "outside the switcher the dashboard contains no plumbing business data",
    !stripBusinessSwitcher(multiDash.body).includes(PLUMBING_NAME),
    "found the other tenant's name in the page body",
  );
  const multiEdit = await multi.post("/api/dashboard/profile", profileForm(await readProfile(VET_ID), { city: "Not Allowed" }));
  check("staff role at the switched business is refused for profile edits (403)", multiEdit.status === 403, multiEdit.status);

  /* -- 6. expired and non-member sessions -------------------------------- */
  section("6. Expired session and session forced onto a foreign business");
  const staffToken = staff.token();
  if (!staffToken) throw new Error("staff session token missing");
  // Age the session row instead of only moving expires_at backwards: the sessions table has
  // `check (expires_at > created_at)`, and a lone single-row UPDATE trips it, so the tampering
  // never happened and every section-6 check after it was silently skipped. Move both stamps
  // together into the past so the constraint holds and the row really is expired.
  const aged = await sql`
    update public.sessions
       set created_at = now() - interval '13 hours',
           expires_at = now() - interval '1 minute'
     where token_hash = ${sha256(staffToken)}
    returning expires_at < now() as is_expired`;
  check("the staff session row was really expired (tampering applied)", aged[0]?.is_expired === true, aged[0]);
  const expiredDash = await staff.get("/dashboard");
  check("an expired session is refused and redirected to sign-in", isRedirectTo(expiredDash, "/sign-in"), expiredDash.status);
  const expiredApi = await staff.get("/api/dashboard/profile");
  check("an expired session gets 401 from the API", expiredApi.status === 401, expiredApi.status);

  // Simulate a stale/crafted session that points at a business the user is NOT a member of:
  // even with a valid session row, the app + RLS must refuse the plumbing tenant to the vet owner.
  const vetToken = vet.token();
  if (!vetToken) throw new Error("vet session token missing");
  await sql`update public.sessions set active_business_id = ${PLUMBING_ID} where token_hash = ${sha256(vetToken)}`;
  const forcedApi = await vet.get("/api/dashboard/profile");
  check("a session forced onto a non-member business gets 403 from the API", forcedApi.status === 403, forcedApi.status);
  const forcedDash = await vet.get("/dashboard");
  check(
    "the dashboard for that session renders no plumbing data",
    forcedDash.status === 200 && !forcedDash.body.includes(PLUMBING_NAME) && forcedDash.body.includes("Not permitted"),
    { status: forcedDash.status, refused: forcedDash.body.includes("Not permitted") },
  );
  await sql`update public.sessions set active_business_id = ${VET_ID} where token_hash = ${sha256(vetToken)}`;
  const restoredApi = await vet.get("/api/dashboard/profile");
  check("restoring the session to a real membership works again", JSON.parse(restoredApi.body).active_business?.id === VET_ID);

  exitCode = failures.length === 0 ? 0 : 1;
} catch (err) {
  failures.push("unexpected error: " + (err instanceof Error ? err.message : String(err)));
  console.error("\nUnexpected error during test:auth:", err);
  console.error("NOTE: is the app running on " + BASE + "? Start it with `bun run start`.");
  exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("failed checks:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log("\nauth and tenant isolation NOT verified");
} else {
  console.log("auth verified end-to-end over HTTP: sign-in, roles, profile edit, and no tenant can reach another's rows");
}
process.exit(exitCode);

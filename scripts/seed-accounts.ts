import postgres from "postgres";
import { hashPassword } from "../src/lib/auth/password.ts";

/**
 * Creates the documented SYNTHETIC demonstration accounts.
 *
 * Runs as the schema owner (MIGRATION_DATABASE_URL) because provisioning identities and
 * memberships is not something a tenant session may do. Every row is marked
 * `is_synthetic = true` with the demo batch label, exactly like the rest of the seed data.
 *
 * Idempotent: re-running resets the passwords, memberships and sessions of these accounts only.
 * The credentials are published in README.md and docs/RUNBOOK.md — they are fictional accounts
 * on a fictional dataset, and nothing else may ever share these passwords.
 */
const BATCH = "demo-2026-10";
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL is not set. See docs/RUNBOOK.md.");
  process.exit(1);
}

const PLUMBING = "11111111-1111-4111-8111-111111111111";
const VET = "22222222-2222-4222-8222-222222222222";

type Account = {
  id: string;
  email: string;
  password: string;
  displayName: string;
  memberships: { businessId: string; role: "business_owner" | "business_staff" }[];
  note: string;
};

export const DEMO_ACCOUNTS: Account[] = [
  {
    id: "11111111-0000-4000-8000-000000000001",
    email: "owner@pacificcoastplumbing-demo.example",
    password: "Plumbing!Demo2026",
    displayName: "Dana Whitlock (demo owner)",
    memberships: [{ businessId: PLUMBING, role: "business_owner" }],
    note: "Owner of the plumbing tenant: can view and configure it, cannot see the veterinary tenant.",
  },
  {
    id: "11111111-0000-4000-8000-000000000002",
    email: "staff@pacificcoastplumbing-demo.example",
    password: "Staff!Demo2026",
    displayName: "Marco Reyes (demo staff)",
    memberships: [{ businessId: PLUMBING, role: "business_staff" }],
    note: "Plumbing staff: read-only; profile edits are refused server-side.",
  },
  {
    id: "22222222-0000-4000-8000-000000000001",
    email: "owner@pacificpaws-demo.example",
    password: "Paws!Demo2026",
    displayName: "Dr. Priya Raghavan (demo owner)",
    memberships: [{ businessId: VET, role: "business_owner" }],
    note: "Owner of the veterinary tenant: cannot see the plumbing tenant.",
  },
  {
    id: "33333333-0000-4000-8000-000000000001",
    email: "multi@servicefront-demo.example",
    password: "Multi!Demo2026",
    displayName: "Sam Okafor (demo multi-business)",
    memberships: [
      { businessId: PLUMBING, role: "business_owner" },
      { businessId: VET, role: "business_staff" },
    ],
    note: "Member of both tenants: owner at plumbing, staff at the vet clinic — demonstrates switching and role change per business.",
  },
];

const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  for (const account of DEMO_ACCOUNTS) {
    const passwordHash = await hashPassword(account.password);
    await sql`
      insert into public.users (id, email, password_hash, display_name, status, is_synthetic, synthetic_batch)
      values (${account.id}, ${account.email}, ${passwordHash}, ${account.displayName}, 'active', true, ${BATCH})
      on conflict (id) do update set
        email = excluded.email,
        password_hash = excluded.password_hash,
        display_name = excluded.display_name,
        status = 'active',
        is_synthetic = true,
        synthetic_batch = excluded.synthetic_batch`;

    for (const m of account.memberships) {
      await sql`
        insert into public.business_members
          (business_id, user_id, role, status, email, display_name, is_synthetic, synthetic_batch)
        values (${m.businessId}, ${account.id}, ${m.role}, 'active', ${account.email}, ${account.displayName}, true, ${BATCH})
        on conflict (business_id, user_id) do update set
          role = excluded.role,
          status = 'active',
          email = excluded.email,
          display_name = excluded.display_name,
          is_synthetic = true,
          synthetic_batch = excluded.synthetic_batch`;
    }
  }

  // Start every demo run from a clean slate: no session from a previous run stays valid.
  const ids = DEMO_ACCOUNTS.map((a) => a.id);
  await sql`delete from public.sessions where user_id in ${sql(ids)}`;

  const [{ n: userCount }] = await sql`select count(*)::int as n from public.users where is_synthetic`;
  const [{ n: memberCount }] = await sql`select count(*)::int as n from public.business_members where is_synthetic`;

  console.log(`seeded ${DEMO_ACCOUNTS.length} synthetic demo accounts (${userCount} synthetic users, ${memberCount} memberships)`);
  for (const a of DEMO_ACCOUNTS) {
    console.log(`  ${a.email}  roles: ${a.memberships.map((m) => `${m.role} @ ${m.businessId.slice(0, 8)}`).join(", ")}`);
  }
  console.log(`batch=${BATCH} (passwords are scrypt-hashed; plaintext exists only in the docs)`);
} finally {
  await sql.end({ timeout: 5 });
}

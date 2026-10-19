# Data model and tenancy model

Source of truth is `db/migrations/*.sql`. This document explains the shape and, more importantly,
the *reasoning* behind the tenancy model. Where this document and the SQL disagree, the SQL wins.

## Design principle

One database serves every business. There is no per-tenant schema and no per-tenant database.
Isolation is enforced by PostgreSQL row-level security (RLS) on `business_id`, not by application
`where` clauses. The application's own queries are therefore not trusted to be correct: a bug that
forgets a filter returns nothing, it does not leak another tenant's rows.

## The two roles

| Role | Used by | Properties |
| --- | --- | --- |
| `servicefront_owner` | migrations, seed, reset, isolation test | owns the schema, `BYPASSRLS`. Local stand-in for Supabase's `postgres` / service-role connection. |
| `servicefront_app` | the running Next.js app | `NOBYPASSRLS`, owns **no** tables. Only table-level privileges granted by `0007_grants_and_health.sql`. |

The isolation test begins with a preflight assertion that the app role really cannot bypass RLS and
really owns no tables — otherwise every later result would be vacuous. If a table were created by
the app role, that role would be its owner and could bypass its own policies.

## Request context

Every database call that touches tenant data runs inside `withTenantTransaction()` in
`src/lib/db/tenancy.ts`, which:

1. opens a transaction,
2. sets `app.current_business_id` and `app.current_user_id` with `set_config(..., true)`
   (transaction-local, so it cannot leak to the next request served by a pooled connection),
3. runs the caller's work,
4. commits or rolls back.

RLS policies read those settings through helper functions and compare against
`business_members`. Two independent conditions must hold for a row to be visible:

- the row's `business_id` equals the context business, **and**
- the context user has a live membership row for that business.

## Why missing context fails closed

The helper functions return `NULL` when a setting is absent, and a policy expression that evaluates
to `NULL` is **not true**, so no row matches. This is deliberate:

- If `app.current_business_id` is unset, `business_id = NULL` is never true → **0 rows**, not all rows.
- If the user id is unset or the user is not a member, the membership subquery yields nothing →
  **0 rows**.
- An `INSERT` with no context fails the `WITH CHECK` expression outright, so it raises
  SQLSTATE `42501` instead of writing an unattributed row.

The alternative — policies that default to "allow when unset", or an app that filters in TypeScript —
fails open the first time someone forgets a filter, and a forgotten filter is a silent cross-tenant
data leak. Failing closed turns that same mistake into an empty page, which is loud, harmless and
easy to diagnose.

This is verified directly by the isolation suite: "no context: services returns 0 rows (not all
rows)", "no context: INSERT is refused by RLS (SQLSTATE 42501)", "user id set but no business id",
"business id set but no user id", and "non-member user id".

## Tables

Grouped by purpose. All tenant-owned tables carry `business_id uuid not null references businesses(id)`.

**Tenancy**
- `businesses` — one row per customer business: slug, name, industry, public widget key, safety-policy settings.
- `business_members` — (business, user) → role. The membership check the RLS policies depend on.

**Knowledge base** (what the assistant is allowed to say)
- `services` — what the business offers.
- `service_areas` — where it operates (this is what answers "Do you service Fullerton?").
- `faqs` — approved question/answer pairs.
- `business_hours` — opening hours, including after-hours logic.

**Conversations**
- `conversations` — one per visitor session; unique on `(id, business_id)`.
- `messages` — turns within a conversation. Carries provenance: `role`, `source`
  (visitor / staff / assistant_live / assistant_demo …), `model_name`, token counts, latency, and a
  `confidence` score, so a stored answer can always be traced back to how it was produced.

**Leads**
- `leads` — captured contact details, after-hours flag, consent flag.
- `lead_status_history` — append-only status transitions.

**Operations**
- `notifications`, `usage_events` (groundwork for cost-per-conversation and future tiers),
  `audit_logs` (append-only record of sensitive actions, including support access).

`0007_grants_and_health.sql` grants the app role its table privileges and provides the database
objects that `/api/health` uses, so a health check reflects real database state rather than a
hard-coded `200`.

## The composite foreign key: defence in depth

`messages` does not merely reference `conversations(id)`. It declares:

```sql
foreign key (conversation_id, business_id) references conversations (id, business_id)
```

supported by `unique (id, business_id)` on `conversations`. Because the pair must match, a message
whose `business_id` disagrees with its conversation's `business_id` is impossible to store even if
RLS were somehow bypassed or an application query were wrong. This is a second, independent layer
below RLS.

The isolation suite tests that layer on its own, with RLS bypassed, and expects SQLSTATE `23503`.

One subtlety worth recording, because it cost time to diagnose: when context A attempts
`insert into messages ... select ... from conversations where business_id = B`, RLS hides B's
conversations, so the `SELECT` yields no source rows. The statement therefore **succeeds while
writing zero rows**. "No exception" does not mean "the write landed". The suite asserts the real
property — refused, or zero rows written — and then additionally verifies directly that no message
row exists whose `business_id` disagrees with its conversation's.

## Support access (platform admin)

Platform-admin access to tenant data is **off by default**. A request must explicitly opt in by
setting a support-access flag in the context, and:

- it grants **read only** — the isolation suite asserts an admin with opt-in still cannot write;
- it is recorded in `audit_logs` — the suite asserts the audit row exists.

Without the opt-in, an admin sees another tenant's rows as 0. Admin status is never a silent
superpower.

## Synthetic data

Every synthetic row is marked `is_synthetic = true` with a `synthetic_batch` tag
(`demo-2026-10` for the seed, `isolation-test` for the test fixture), so demonstration data can be
removed with one predicate and can never be mistaken for a real customer's data. Check constraints
enforce that a row claiming to be synthetic actually carries a batch tag, and that an answer whose
`source` is `assistant_live` must name a `model_name` — a demo answer cannot masquerade as a live
model answer at the storage layer.

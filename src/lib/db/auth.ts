import { getSql } from "./client";
import { withTenant, type TenantContext } from "./tenancy";
import { logger } from "@/lib/logger";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * ============================================================================
 *  Authentication data access
 * ============================================================================
 * `users` and `sessions` are not tenant tables: a sign-in has to be resolved before any
 * business is known. They therefore have row-level security ENABLED and FORCED with no
 * policies, so the application role reads zero rows from them directly. Every read/write below
 * goes through a narrowly-scoped SECURITY DEFINER function from migration 0008
 * (`app.auth_*`), which is the only door into those tables.
 *
 * Membership and audit reads/writes DO go through `withTenant`, i.e. through RLS.
 */

export type AuthUserRecord = {
  id: string;
  email: string;
  password_hash: string;
  status: "active" | "disabled";
  display_name: string | null;
};

export type SessionBusiness = {
  business_id: string;
  role: "business_owner" | "business_staff";
  name: string;
  slug: string;
};

export type SessionRecord = {
  session_id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  active_business_id: string | null;
  expires_at: string;
  businesses: SessionBusiness[];
};

function asJson(row: unknown): any {
  return (row as any)?.r ?? null;
}

/** Credential row for an email, or null. The KDF string never leaves the server. */
export async function findCredentialByEmail(email: string): Promise<AuthUserRecord | null> {
  const sql = getSql();
  const rows = (await sql`select app.auth_user_by_email(${email}) as r`) as any[];
  return asJson(rows[0]);
}

/** A valid-format KDF string used to spend the same CPU when the email does not exist. */
export async function dummyPasswordHash(): Promise<string> {
  const sql = getSql();
  const rows = (await sql`select app.auth_dummy_password_hash() as r`) as any[];
  return (rows[0]?.r as string) ?? "";
}

export async function createSession(input: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  ipHash: string | null;
  userAgentFamily: string | null;
}): Promise<{ session_id: string; business_id: string | null }> {
  const sql = getSql();
  const rows = (await sql`
    select app.auth_create_session(
      ${input.userId}::uuid, ${input.tokenHash}, ${input.expiresAt.toISOString()}::timestamptz,
      ${input.ipHash}, ${input.userAgentFamily}
    ) as r`) as any[];
  return asJson(rows[0]);
}

/** Live session for a cookie token, or null when unknown / revoked / expired. */
export async function loadSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
  const sql = getSql();
  const rows = (await sql`select app.auth_session(${tokenHash}) as r`) as any[];
  return asJson(rows[0]);
}

export async function revokeSession(tokenHash: string): Promise<boolean> {
  const sql = getSql();
  const rows = (await sql`select app.auth_revoke_session(${tokenHash}) as r`) as any[];
  return rows[0]?.r === true;
}

/**
 * Switch the session's active business. The database re-checks `business_members` itself and
 * returns false when the user is not an active member, so a forged business id can never take
 * effect even if application code were wrong.
 */
export async function switchSessionBusiness(tokenHash: string, businessId: string): Promise<boolean> {
  const sql = getSql();
  const rows = (await sql`select app.auth_switch_business(${tokenHash}, ${businessId}::uuid) as r`) as any[];
  return rows[0]?.r === true;
}

export async function touchSession(tokenHash: string): Promise<void> {
  const sql = getSql();
  await sql`select app.auth_touch_session(${tokenHash})`;
}

/**
 * Role of `userId` in `businessId`, read through RLS with the tenant context applied. Used as
 * defence in depth on top of the session's own membership list: a revoked membership loses
 * access on the very next request even though the session row still exists.
 */
export async function getMembershipRole(
  context: TenantContext,
  userId: string,
): Promise<"business_owner" | "business_staff" | null> {
  return withTenant(context, async (tx) => {
    const rows = (await tx`
      select role::text as role
      from public.business_members
      where business_id = ${context.businessId} and user_id = ${userId} and status = 'active'
      limit 1`) as any[];
    return (rows[0]?.role as "business_owner" | "business_staff") ?? null;
  });
}

/** Append-only audit entry for the authentication flow (sign-in / sign-out). */
export async function recordAuthAudit(
  context: TenantContext,
  input: {
    action: "auth.signed_in" | "auth.signed_out";
    role: "business_owner" | "business_staff";
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await withTenant(context, async (tx) => {
      await tx`
        insert into public.audit_logs
          (business_id, actor_user_id, actor_role, action, target_type, target_id, metadata, is_synthetic)
        values (
          ${context.businessId}, ${context.userId}, ${input.role}, ${input.action},
          'session', ${context.requestId ?? null}, ${input.metadata ?? {}}, false
        )`;
    });
  } catch (err) {
    // Never fail a sign-in because the audit write failed; log it loudly instead.
    logger.error("audit write failed for auth event", {
      action: input.action,
      reason: err instanceof Error ? err.message : "unknown",
    });
  }
}

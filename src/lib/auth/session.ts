import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { cache } from "react";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  createSession,
  dummyPasswordHash,
  findCredentialByEmail,
  loadSessionByTokenHash,
  recordAuthAudit,
  revokeSession,
  switchSessionBusiness,
  touchSession,
  type SessionBusiness,
} from "@/lib/db/auth";
import { hashPassword, verifyPassword } from "./password";
import { clearFailures, hashKey, isRateLimited, recordFailure } from "./rate-limit";

/**
 * ============================================================================
 *  Server-side sessions
 * ============================================================================
 * Identity comes from ONE place: the opaque token in an httpOnly cookie, resolved against the
 * `sessions` table on the server. Nothing a browser sends (not a query string, not a form
 * field, not a header) can name the user or the active business.
 *
 * Cookie flags: httpOnly, SameSite=Lax, Secure in production, Path=/, explicit expiry.
 * The database stores only sha256(token), so a database read cannot be replayed as a login.
 *
 * HOSTED-AUTH MIGRATION POINT (the one place that changes)
 * -------------------------------------------------------
 * If the owner moves to hosted Supabase Auth, this file is the only module that changes:
 *   - setSessionCookie/clearSessionCookie are replaced by Supabase's cookie helpers,
 *   - getSession() reads and verifies the Supabase JWT (sub = user id) instead of calling
 *     loadSessionByTokenHash(),
 *   - signIn()/signOut() call supabase.auth.signInWithPassword / signOut,
 *   - `app.auth_*` SQL functions and the `users`/`sessions` tables are dropped.
 * `src/lib/auth/authorize.ts`, the tenancy context, every RLS policy and every page are
 * unchanged, because business_members.user_id already stores the identity provider's user id.
 */

export const SESSION_COOKIE = "sf_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export type SessionUser = { id: string; email: string; display_name: string | null };

export type ActiveBusiness = {
  id: string;
  name: string;
  slug: string;
  role: "business_owner" | "business_staff";
};

export type SessionContext = {
  sessionId: string;
  tokenHash: string;
  user: SessionUser;
  activeBusinessId: string | null;
  activeBusiness: ActiveBusiness | null;
  businesses: SessionBusiness[];
};

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function cookiesOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env().NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  };
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, cookiesOptions(expiresAt));
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { ...cookiesOptions(new Date(0)), maxAge: 0 });
}

/**
 * Current session, or null. Memoised per request so a page that calls it in the layout and in
 * the page still hits the database once.
 */
export const getSession = cache(async (): Promise<SessionContext | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token || token.length < 20) return null;
  const tokenHash = hashSessionToken(token);
  const record = await loadSessionByTokenHash(tokenHash);
  if (!record) return null;

  const businesses = Array.isArray(record.businesses) ? record.businesses : [];
  const active =
    businesses.find((b) => b.business_id === record.active_business_id) ?? businesses[0] ?? null;

  return {
    sessionId: record.session_id,
    tokenHash,
    user: { id: record.user_id, email: record.email, display_name: record.display_name },
    activeBusinessId: active?.business_id ?? null,
    activeBusiness: active
      ? { id: active.business_id, name: active.name, slug: active.slug, role: active.role }
      : null,
    businesses,
  };
});

export type SignInResult =
  | { ok: true; token: string; expiresAt: Date; session: SessionContext }
  | { ok: false; error: "invalid_credentials" | "rate_limited" };

/**
 * Verify credentials and open a session.
 *
 * Every failure returns the SAME result ("invalid_credentials"), and an unknown email still
 * spends a full scrypt verification against a dummy hash, so neither the message nor the
 * timing reveals whether an account exists.
 */
export async function signIn(
  email: string,
  password: string,
  meta: { clientKey: string; ipHash: string | null; userAgentFamily: string | null },
): Promise<SignInResult> {
  const normalizedEmail = email.trim().toLowerCase();
  const accountKey = hashKey(normalizedEmail);
  if (isRateLimited(accountKey, meta.clientKey)) return { ok: false, error: "rate_limited" };

  let verified = false;
  let userId: string | null = null;
  try {
    const user = await findCredentialByEmail(normalizedEmail);
    if (user && user.status === "active") {
      verified = await verifyPassword(password, user.password_hash);
      if (verified) userId = user.id;
    } else {
      await verifyPassword(password, await dummyPasswordHash());
    }
  } catch (err) {
    logger.error("sign-in lookup failed", { reason: err instanceof Error ? err.message : "unknown" });
    return { ok: false, error: "invalid_credentials" };
  }

  if (!verified || !userId) {
    const nowBlocked = recordFailure(accountKey, meta.clientKey);
    logger.warn("sign-in failed", { account: accountKey.slice(0, 12), blocked: nowBlocked });
    return { ok: false, error: nowBlocked ? "rate_limited" : "invalid_credentials" };
  }

  clearFailures(accountKey);
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await createSession({
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
    ipHash: meta.ipHash,
    userAgentFamily: meta.userAgentFamily,
  });

  const session = await loadSessionByTokenHash(hashSessionToken(token));
  if (!session) throw new Error("session_created_but_unreadable");

  const businesses = session.businesses ?? [];
  const active =
    businesses.find((b) => b.business_id === session.active_business_id) ?? businesses[0] ?? null;

  if (active) {
    await recordAuthAudit(
      {
        businessId: active.business_id,
        userId: session.user_id,
        supportAccess: false,
      },
      { action: "auth.signed_in", role: active.role, metadata: { method: "password" } },
    );
  }

  return {
    ok: true,
    token,
    expiresAt,
    session: {
      sessionId: session.session_id,
      tokenHash: hashSessionToken(token),
      user: { id: session.user_id, email: session.email, display_name: session.display_name },
      activeBusinessId: active?.business_id ?? null,
      activeBusiness: active
        ? { id: active.business_id, name: active.name, slug: active.slug, role: active.role }
        : null,
      businesses,
    },
  };
}

/** Revoke this session and clear the cookie. Safe to call with no cookie. */
export async function signOut(): Promise<void> {
  const session = await getSession();
  if (session) {
    if (session.activeBusiness) {
      await recordAuthAudit(
        { businessId: session.activeBusiness.id, userId: session.user.id, supportAccess: false },
        { action: "auth.signed_out", role: session.activeBusiness.role },
      );
    }
    await revokeSession(session.tokenHash);
  }
  await clearSessionCookie();
}

/** Re-check the cookie after the active business was switched, and refresh last_seen_at. */
export async function afterBusinessSwitch(tokenHash: string): Promise<void> {
  await touchSession(tokenHash);
}

export async function switchActiveBusiness(session: SessionContext, businessId: string): Promise<boolean> {
  return switchSessionBusiness(session.tokenHash, businessId);
}

/**
 * Demo/test helper: hash a password with the application's KDF parameters. Used by
 * scripts/seed-accounts.ts so the seeded hashes are produced by the same code that verifies them.
 */
export async function hashPasswordForSeed(password: string): Promise<string> {
  return hashPassword(password);
}

import { redirect } from "next/navigation";
import { getSession, type ActiveBusiness, type SessionContext } from "./session";
import { getMembershipRole } from "@/lib/db/auth";
import { z } from "zod";
import { logger } from "@/lib/logger";

/**
 * ============================================================================
 *  Authorisation helpers — called by every dashboard page and every protected route
 * ============================================================================
 * Roles (from the business plan and the `member_role` enum):
 *   business_owner  -> may view the business and configure it
 *   business_staff  -> may view the business, read-only for configuration
 *   (no membership) -> nothing at all: no data, no shell, no edit
 *
 * Two independent checks stand between a request and a tenant's data:
 *   1. THIS file: the session exists, the session claims a business, and the database confirms
 *      the user is still an active member of it (`business_members`, read through RLS).
 *   2. Postgres RLS: `app.current_business_id` / `app.current_user_id` are set per request by
 *      withTenant*, so even a bug in this file returns zero rows rather than another tenant's.
 *
 * Hiding a button is never the enforcement. The route handlers call requireBusinessAccess()
 * themselves, so a crafted POST is refused with 403 even though the button was hidden.
 */

export type TenantRole = "business_owner" | "business_staff";

export class AuthorizationError extends Error {
  constructor(
    public readonly code: "unauthenticated" | "no_business" | "not_a_member" | "insufficient_role",
    message: string,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
  get status(): number {
    return this.code === "unauthenticated" ? 401 : 403;
  }
}

export type TenantContextInput = {
  businessId: string;
  userId: string;
  supportAccess: boolean;
  requestId?: string;
};

export type Authorized = {
  session: SessionContext;
  business: ActiveBusiness;
  role: TenantRole;
  context: TenantContextInput;
};

/** Page-level gate: no session at all -> sign-in page. */
export async function requireSession(): Promise<SessionContext> {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return session;
}

/**
 * Page/handler-level gate for tenant data.
 *
 * Throws AuthorizationError:
 *   unauthenticated   the caller has no valid session (route handlers answer 401)
 *   no_business       the session has no business attached (member of nothing)
 *   not_a_member      the session's active business is no longer one of the user's memberships
 */
export async function requireBusinessAccess(session?: SessionContext): Promise<Authorized> {
  const s = session ?? (await getSession());
  if (!s) throw new AuthorizationError("unauthenticated", "Please sign in.");
  // A session whose active business is not one of the user's memberships is refused
  // explicitly. It is never repaired into a different business - see
  // resolveActiveBusiness() in ./session.
  if (s.activeBusinessInvalid) {
    throw new AuthorizationError(
      "not_a_member",
      "This session points at a business you are not a member of.",
    );
  }
  if (!s.activeBusinessId || !s.activeBusiness) {
    throw new AuthorizationError("no_business", "This account is not a member of any business.");
  }

  const businessId = s.activeBusinessId;
  // Defence in depth: the session's own membership list must contain the active business...
  if (!s.businesses.some((b) => b.business_id === businessId)) {
    throw new AuthorizationError("not_a_member", "You do not have access to this business.");
  }

  // ...and the database must still agree, on every request.
  const context: TenantContextInput = { businessId, userId: s.user.id, supportAccess: false };
  let role: TenantRole | null = null;
  try {
    role = (await getMembershipRole(context, s.user.id)) as TenantRole | null;
  } catch (err) {
    logger.error("membership lookup failed", { reason: err instanceof Error ? err.message : "unknown" });
    throw new AuthorizationError("not_a_member", "You do not have access to this business.");
  }
  if (!role) throw new AuthorizationError("not_a_member", "You do not have access to this business.");

  return {
    session: s,
    business: { ...s.activeBusiness, role },
    role,
    context,
  };
}

/**
 * Page helper: like requireBusinessAccess(), but a refusal is returned as `{ ok: false, ... }`
 * instead of thrown, so a page can render a refusal panel that contains NO tenant data. A
 * missing session still redirects (that is the sign-in gate, handled by requireSession()).
 */
export async function tryBusinessAccess(
  session?: SessionContext,
): Promise<{ ok: true; authorized: Authorized } | { ok: false; code: string; message: string }> {
  try {
    return { ok: true, authorized: await requireBusinessAccess(session) };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      if (err.code === "unauthenticated") redirect("/sign-in");
      return { ok: false, code: err.code, message: err.message };
    }
    throw err;
  }
}

/** Owner/admin may configure the business. Staff are read-only for configuration. */
export function canConfigure(role: TenantRole): boolean {
  return role === "business_owner";
}

/** Throws unless the caller may change business configuration. Called from the write handler. */
export function requireCanConfigure(authorized: Authorized): void {
  if (!canConfigure(authorized.role)) {
    throw new AuthorizationError(
      "insufficient_role",
      "Only a business owner or admin can change these settings.",
    );
  }
}

/**
 * Switching the active business. The target id must appear in the session's verified membership
 * list AND be re-verified by the database (`app.auth_switch_business`); a non-member id is
 * refused, never silently ignored.
 */
export async function verifySwitchTarget(session: SessionContext, targetBusinessId: string): Promise<void> {
  const parsed = z.string().uuid().safeParse(targetBusinessId);
  if (!parsed.success) throw new AuthorizationError("not_a_member", "Unknown business.");
  if (!session.businesses.some((b) => b.business_id === parsed.data)) {
    throw new AuthorizationError("not_a_member", "You do not have access to that business.");
  }
}

import { NextResponse } from "next/server";
import { getSession, afterBusinessSwitch, switchActiveBusiness } from "@/lib/auth/session";
import { AuthorizationError, requireBusinessAccess, verifySwitchTarget } from "@/lib/auth/authorize";
import { forbiddenPage, isSameOrigin } from "@/lib/auth/request-guard";

/**
 * POST /api/auth/switch-business (form-encoded: business_id)
 *
 * The target id comes from the form, but it is only ever used as a *request*: the session's
 * verified membership list must contain it, and the database re-checks business_members before
 * the session row is updated. A non-member id is refused with 403 — never silently ignored.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "cross_origin_request_refused" }, { status: 403 });
  }

  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL("/sign-in", request.url), 303);

  const form = await request.formData();
  const target = String(form.get("business_id") ?? "");

  try {
    await verifySwitchTarget(session, target);
    const switched = await switchActiveBusiness(session, target);
    if (!switched) {
      // The database refused (membership revoked, session expired): nothing changes.
      return forbiddenPage("That business is not available to this account.");
    }
    await afterBusinessSwitch(session.tokenHash);
  } catch (err) {
    if (err instanceof AuthorizationError) return forbiddenPage(err.message);
    throw err;
  }

  return NextResponse.redirect(new URL("/dashboard", request.url), 303);
}

import { NextResponse } from "next/server";
import { signIn, setSessionCookie } from "@/lib/auth/session";
import { clientKey, ipHash, isSameOrigin, userAgentFamily } from "@/lib/auth/request-guard";
import { signInSchema } from "@/lib/validation/business-profile";
import { logger } from "@/lib/logger";

/**
 * POST /api/auth/sign-in  (form-encoded: email, password)
 *
 * Failure ALWAYS redirects to the same generic message, whatever the cause (unknown account,
 * wrong password, unknown email), so this endpoint cannot be used to enumerate accounts.
 * Rate limiting is per account and per client, in-process — see src/lib/auth/rate-limit.ts.
 *
 * Body handling: this endpoint speaks application/x-www-form-urlencoded only (the sign-in form
 * posts it). A JSON body, a multipart body or a truncated body is a caller error and gets a
 * clean 400 — it must never escape as a 500, and it never reaches signIn().
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BAD_BODY = {
  error: "invalid_request",
  message: "Send the sign-in form as application/x-www-form-urlencoded with email and password.",
} as const;

/** True only for a form-encoded body (or no body at all, which is then rejected by validation). */
function isFormEncoded(request: Request): boolean {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  return type === "" || type.includes("application/x-www-form-urlencoded");
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "cross_origin_request_refused" }, { status: 403 });
  }

  const back = new URL("/sign-in", request.url);

  let form: FormData;
  try {
    // A non-form content-type is refused before the body is touched; a body that still fails to
    // parse (truncated, wrong charset, unreadable stream) is caught here rather than bubbling.
    if (!isFormEncoded(request)) return NextResponse.json(BAD_BODY, { status: 400 });
    form = await request.formData();
  } catch {
    return NextResponse.json(BAD_BODY, { status: 400 });
  }

  const parsed = signInSchema.safeParse({
    email: form.get("email") ?? "",
    password: form.get("password") ?? "",
  });
  if (!parsed.success) {
    back.searchParams.set("error", "invalid");
    return NextResponse.redirect(back, 303);
  }

  try {
    const result = await signIn(parsed.data.email, parsed.data.password, {
      clientKey: clientKey(request),
      ipHash: ipHash(request),
      userAgentFamily: userAgentFamily(request),
    });
    if (!result.ok) {
      // Same generic message for every failure reason.
      back.searchParams.set("error", "invalid");
      return NextResponse.redirect(back, 303);
    }
    await setSessionCookie(result.token, result.expiresAt);
    const target = new URL("/dashboard", request.url);
    if (!result.session.activeBusiness) target.searchParams.set("status", "no_business");
    return NextResponse.redirect(target, 303);
  } catch (err) {
    logger.error("sign-in route failed", { reason: err instanceof Error ? err.message : "unknown" });
    back.searchParams.set("error", "unavailable");
    return NextResponse.redirect(back, 303);
  }
}

export async function GET(request: Request) {
  return NextResponse.redirect(new URL("/sign-in", request.url), 303);
}

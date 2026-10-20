import { NextResponse } from "next/server";
import { signOut } from "@/lib/auth/session";
import { isSameOrigin } from "@/lib/auth/request-guard";

/**
 * POST /api/auth/sign-out — revokes the session server-side (so the old cookie is dead even if
 * it was copied) and clears the cookie.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "cross_origin_request_refused" }, { status: 403 });
  }
  await signOut();
  return NextResponse.redirect(new URL("/sign-in?status=signed_out", request.url), 303);
}

export async function GET(request: Request) {
  return NextResponse.redirect(new URL("/sign-in", request.url), 303);
}

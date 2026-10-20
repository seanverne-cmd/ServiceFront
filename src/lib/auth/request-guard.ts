import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { AuthorizationError } from "./authorize";

/**
 * Request guards shared by the auth routes.
 */

/**
 * CSRF defence for state-changing form posts. A browser always sends `Origin` on a
 * cross-site form POST; if it does and it does not match this host, the request is refused.
 * (Non-browser clients such as the scripted end-to-end check send no Origin and pass through —
 * they cannot be forged by a third-party page, because they must already hold the cookie.)
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
    return originHost === host;
  } catch {
    return false;
  }
}

/** Coarse client key for rate limiting: hashed forwarded IP, else hashed user agent. */
export function clientKey(request: Request): string {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "local";
  return createHash("sha256").update(`client:${ip}`).digest("hex");
}

export function ipHash(request: Request): string | null {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip");
  if (!ip) return null;
  // Salted with the app secret so the stored value is not a rainbow-table lookup of all IPv4 space.
  return createHash("sha256").update(`ip:${ip}:${process.env.SESSION_SECRET ?? "dev"}`).digest("hex");
}

export function userAgentFamily(request: Request): string | null {
  const ua = request.headers.get("user-agent");
  if (!ua) return null;
  if (/curl\//i.test(ua)) return "curl";
  if (/bun\//i.test(ua)) return "bun";
  if (/edg\//i.test(ua)) return "edge";
  if (/firefox\//i.test(ua)) return "firefox";
  if (/chrome\//i.test(ua)) return "chrome";
  if (/safari\//i.test(ua)) return "safari";
  return "other";
}

/** 403 page for a refused action (never reached through the UI, only by a crafted request). */
export function forbiddenPage(message: string): NextResponse {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>403 Not permitted</title>
     <body style="font-family:system-ui;max-width:40rem;margin:4rem auto;line-height:1.5">
     <h1>403 — Not permitted</h1><p>${message}</p>
     <p><a href="/dashboard">Back to the dashboard</a></p></body>`,
    { status: 403, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export function authorizationResponse(err: unknown, request: Request): NextResponse {
  if (err instanceof AuthorizationError) {
    if (err.code === "unauthenticated") {
      return NextResponse.redirect(new URL("/sign-in", request.url), 303);
    }
    return forbiddenPage(err.message);
  }
  throw err;
}

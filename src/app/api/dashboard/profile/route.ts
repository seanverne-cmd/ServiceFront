import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  AuthorizationError,
  requireBusinessAccess,
  requireCanConfigure,
} from "@/lib/auth/authorize";
import { isSameOrigin } from "@/lib/auth/request-guard";
import { businessProfileSchema, fieldErrors } from "@/lib/validation/business-profile";
import {
  getBusinessProfileDetail,
  listFaqs,
  listServiceAreas,
  listServices,
  updateBusinessProfile,
} from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * GET  /api/dashboard/profile  -> JSON for the ACTIVE business only (session-derived)
 * POST /api/dashboard/profile  -> persist the profile form; owners only, enforced here
 *
 * Both handlers derive the business from the session, never from the request. A staff account
 * that posts this endpoint is refused with 403 even though the form is hidden from them, and
 * even if they hand-craft the request.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  try {
    const authorized = await requireBusinessAccess(session);
    const [profile, services, areas, faqs] = await Promise.all([
      getBusinessProfileDetail(authorized.context),
      listServices(authorized.context),
      listServiceAreas(authorized.context),
      listFaqs(authorized.context),
    ]);
    if (!profile) return NextResponse.json({ error: "not_found" }, { status: 404 });

    return NextResponse.json(
      {
        active_business: {
          id: profile.id,
          slug: profile.slug,
          name: profile.name,
          industry: profile.industry,
        },
        role: authorized.role,
        can_configure: authorized.role === "business_owner",
        counts: { services: services.length, service_areas: areas.length, faqs: faqs.length },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    throw err;
  }
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "cross_origin_request_refused" }, { status: 403 });
  }

  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL("/sign-in", request.url), 303);

  const back = new URL("/dashboard/profile", request.url);
  const backWith = (status: string) => {
    back.searchParams.set("status", status);
    return NextResponse.redirect(back, 303);
  };

  try {
    const authorized = await requireBusinessAccess(session);
    // Server-side role enforcement, called by the handler itself.
    requireCanConfigure(authorized);

    const form = await request.formData();
    const parsed = businessProfileSchema.safeParse({
      name: form.get("name") ?? "",
      industry: form.get("industry") ?? "",
      website_url: form.get("website_url") ?? "",
      primary_email: form.get("primary_email") ?? "",
      primary_phone: form.get("primary_phone") ?? "",
      city: form.get("city") ?? "",
      region: form.get("region") ?? "",
      public_welcome_message: form.get("public_welcome_message") ?? "",
      hours_summary: form.get("hours_summary") ?? "",
    });

    if (!parsed.success) {
      logger.info("profile validation rejected", { fields: Object.keys(fieldErrors(parsed.error)) });
      return backWith("invalid");
    }

    await updateBusinessProfile(authorized.context, parsed.data, authorized.role);
    return backWith("saved");
  } catch (err) {
    if (err instanceof AuthorizationError) {
      if (err.code === "unauthenticated") {
        return NextResponse.redirect(new URL("/sign-in", request.url), 303);
      }
      // Refusal is a real 403 for the crafted request, not a silent redirect.
      return new NextResponse(
        `<!doctype html><meta charset="utf-8"><title>403 Not permitted</title>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;line-height:1.5">
<h1>403 — Not permitted</h1><p>${err.message}</p><p><a href="/dashboard">Back to the dashboard</a></p></body>`,
        { status: 403, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    logger.error("profile update failed", { reason: err instanceof Error ? err.message : "unknown" });
    return backWith("error");
  }
}

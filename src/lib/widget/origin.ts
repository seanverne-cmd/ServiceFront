import { env } from "@/lib/env";
import type { WidgetBusiness } from "@/lib/db/widget";

/**
 * The embed allow-list, in one place, so the message endpoint and the config endpoint cannot
 * drift apart.
 *
 * A widget id is printed in the customer's page source, so it is public: it is not a credential
 * and it does not identify the page that may use it. The Origin header is what binds a request
 * to a page, and a browser always sends it. A request with no Origin cannot come from a
 * third-party page (it is curl, the test suite, or a server-side render), so it is allowed;
 * everything else must match the business's allow-list exactly.
 *
 * Both loopback spellings matter: a browser or curl reaches the dev server as either
 * `http://localhost:<port>` or `http://127.0.0.1:<port>` depending on what the user typed, and
 * the Origin header carries that spelling verbatim.
 */

export function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

/** The business's own allow-list, plus the single configured public origin of the hosted widget. */
export function allowedOriginsFor(business: WidgetBusiness): string[] {
  const configured = [...business.allowedOrigins, env().PUBLIC_WIDGET_ORIGIN].filter(
    (o): o is string => typeof o === "string" && o.length > 0,
  );
  return [...new Set(configured.map(normalizeOrigin))];
}

export function originAllowed(business: WidgetBusiness, request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return allowedOriginsFor(business).includes(normalizeOrigin(origin));
}

/**
 * CORS headers are echoed only for an allowed origin. `vary: origin` keeps any intermediary
 * from serving one page's response to another page.
 */
export function corsHeaders(origin: string | null, methods = "POST, OPTIONS"): Record<string, string> {
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": methods,
    vary: "origin",
  };
}

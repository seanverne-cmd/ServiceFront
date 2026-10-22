import { env } from "@/lib/env";

/**
 * Rate limits for the public widget endpoint.
 *
 * Two independent buckets, because they defend against different things:
 *   - per client      : one browser tab (or script) hammering the endpoint
 *   - per conversation: a long-running thread forcing unbounded model/DB work
 *
 * In-process and dependency-free, exactly like the sign-in limiter: good enough for a single
 * app instance, and documented as needing a shared store before running more than one. Keys are
 * hashes, so the map holds no visitor text and no raw IP address.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

function limit(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function perClientLimit(): number {
  return limit("WIDGET_RATE_LIMIT_PER_MINUTE", 12);
}

export function perConversationLimit(): number {
  return limit("WIDGET_RATE_LIMIT_PER_CONVERSATION_PER_MINUTE", 30);
}

const WINDOW_MS = limit("WIDGET_RATE_LIMIT_WINDOW_SECONDS", 60) * 1000;

function hit(key: string, max: number, now: number): { blocked: boolean; retryAfter: number } {
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { blocked: false, retryAfter: 0 };
  }
  bucket.count += 1;
  const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  return { blocked: bucket.count > max, retryAfter };
}

/**
 * Count one message against both buckets. Returns the first refusal, or `{ allowed: true }`.
 * A refusal is decided before any database work, knowledge loading or model call happens.
 */
export function checkWidgetRateLimit(
  clientHash: string,
  conversationKey: string | null,
  now: number = Date.now(),
): { allowed: true } | { allowed: false; retryAfter: number; scope: "client" | "conversation" } {
  const client = hit(`c:${clientHash}`, perClientLimit(), now);
  if (client.blocked) return { allowed: false, retryAfter: client.retryAfter, scope: "client" };
  if (conversationKey) {
    const conversation = hit(`v:${conversationKey}`, perConversationLimit(), now);
    if (conversation.blocked) return { allowed: false, retryAfter: conversation.retryAfter, scope: "conversation" };
  }
  return { allowed: true };
}

/** Test helper: forget every counter so a scripted run is repeatable. */
export function resetWidgetRateLimits(): void {
  buckets.clear();
}

/** Environment surface used by /api/widget/<id>/config so the widget can show real limits. */
export function rateLimitSummary(): { perClientPerMinute: number; perConversationPerMinute: number } {
  return {
    perClientPerMinute: perClientLimit(),
    perConversationPerMinute: perConversationLimit(),
  };
}

export { env as widgetEnv };

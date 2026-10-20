import { createHash } from "node:crypto";

/**
 * Small in-process rate limiter for sign-in.
 *
 * Deliberately simple and dependency-free: the failure counters live in this process. That is
 * enough for the single-instance demo. If the platform ever runs more than one app instance the
 * counters must move to a shared store (Postgres table or Redis) — noted in docs/RUNBOOK.md.
 *
 * Keys are hashes, never raw IP addresses or email addresses, so the map itself holds no PII.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_ACCOUNT = 5;
const MAX_FAILURES_PER_CLIENT = 20;
const MAX_ENTRIES = 5000;

export function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bump(key: string, max: number): { blocked: boolean } {
  const now = Date.now();
  if (buckets.size > MAX_ENTRIES) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { blocked: false };
  }
  bucket.count += 1;
  return { blocked: bucket.count > max };
}

/** True when this account/client is already over the limit (checked before verifying). */
export function isRateLimited(accountKey: string, clientKey: string): boolean {
  const now = Date.now();
  for (const key of [accountKey, clientKey]) {
    const bucket = buckets.get(key);
    if (bucket && bucket.resetAt > now && bucket.count > (key === accountKey ? MAX_FAILURES_PER_ACCOUNT : MAX_FAILURES_PER_CLIENT)) {
      return true;
    }
  }
  return false;
}

/** Record a failed attempt. Returns true once the caller should stop trying for a while. */
export function recordFailure(accountKey: string, clientKey: string): boolean {
  const account = bump(accountKey, MAX_FAILURES_PER_ACCOUNT);
  const client = bump(clientKey, MAX_FAILURES_PER_CLIENT);
  return account.blocked || client.blocked;
}

export function clearFailures(accountKey: string): void {
  buckets.delete(accountKey);
}

/** Test helper: reset all counters so a scripted run is repeatable. */
export function resetRateLimits(): void {
  buckets.clear();
}

import { getSql } from "./client";
import { logger, errorMessage } from "@/lib/logger";
import { assertUuid, ValidationError } from "@/lib/validation";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Tenant session context. This is the ONLY way a request may touch tenant data.
 *
 * `businessId` and `userId` are pushed into the database session as transaction-local
 * settings (`set_config(..., true)` == SET LOCAL), so they are visible to the RLS policies
 * for the duration of one transaction and to nothing else — not to the next request that
 * reuses the pooled connection, and not to any other tenant.
 */
export type TenantContext = {
  businessId: string;
  userId: string;
  /**
   * Platform-admin "support access". Off by default; when true the session may READ the
   * tenant's rows (RLS grants no writes to a support session) and the use is logged.
   */
  supportAccess?: boolean;
  requestId?: string;
};

export class TenancyError extends Error {
  readonly reason: string;
  constructor(reason: string, message = "Row-level security rejected this operation") {
    super(message);
    this.name = "TenancyError";
    this.reason = reason;
  }
}

export class DataAccessError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = "DataAccessError";
    this.kind = kind;
  }
}

function assertContext(ctx: TenantContext): TenantContext {
  if (!ctx || typeof ctx !== "object") throw new TenancyError("missing_context");
  const businessId = assertUuid(ctx.businessId, "businessId");
  const userId = assertUuid(ctx.userId, "userId");
  if (ctx.supportAccess === true && !userId) throw new TenancyError("support_without_actor");
  return { ...ctx, businessId, userId };
}

/**
 * Translate a driver error into something safe to hand upward. Nothing from the driver is
 * passed through: no SQL text, no constraint names, no connection details.
 */
export function mapDatabaseError(err: unknown, operation: string): never {
  const code = (err as { code?: string } | null)?.code;
  logger.error("database error", { operation, pgCode: code ?? "unknown", detail: errorMessage(err) });
  switch (code) {
    case "42501":
      throw new TenancyError("rls_policy_violation");
    case "23505":
      throw new DataAccessError("conflict", "That record already exists");
    case "23514":
      throw new DataAccessError("invalid_value", "That value is not allowed");
    case "23503":
      throw new DataAccessError("unknown_reference", "Referenced record does not exist");
    case "22P02":
      throw new ValidationError("invalid input for a database field");
    default:
      throw new DataAccessError("database_error", "The database could not complete the request");
  }
}

/**
 * Runs `fn` inside a single transaction with the tenant context set.
 *
 * The callback receives the raw transaction handle. It is deliberately exported from this
 * module (not from the data-access barrel) so that application code never sees it, while
 * tests can still prove that the database itself — not application code — enforces isolation.
 */
export async function withTenantTransaction<T>(
  context: TenantContext,
  fn: (tx: any) => Promise<T>,
): Promise<T> {
  const ctx = assertContext(context);
  const sql = getSql();
  try {
    // `sql.begin` is typed generously by the driver (it cannot know T's shape across the
    // transaction boundary), so the resolved value is narrowed back to T here.
    return (await sql.begin(async (tx: any) => {
      await tx`select set_config('app.current_business_id', ${ctx.businessId}, true)`;
      await tx`select set_config('app.current_user_id', ${ctx.userId}, true)`;
      await tx`select set_config('app.support_access', ${ctx.supportAccess === true ? "on" : "off"}, true)`;

      if (ctx.supportAccess === true) {
        // Support access is intentionally noisy: it is recorded against the tenant.
        await tx`
          insert into public.audit_logs
            (business_id, actor_user_id, actor_role, action, metadata, is_synthetic, synthetic_batch)
          values (
            ${ctx.businessId}, ${ctx.userId}, 'platform_admin', 'support_access.used',
            ${ { requestId: ctx.requestId ?? null } }, false, null
          )`;
      }

      return await fn(tx);
    })) as T;
  } catch (err) {
    if (err instanceof TenancyError || err instanceof DataAccessError || err instanceof ValidationError) throw err;
    mapDatabaseError(err, "withTenantTransaction");
  }
}

/**
 * Thin wrapper that guarantees every statement in the callback runs with the tenant context
 * already applied. Prefer this in application code; it never exposes the raw pool.
 */
export async function withTenant<T>(
  context: TenantContext,
  fn: (tx: any) => Promise<T>,
): Promise<T> {
  return withTenantTransaction(context, fn);
}

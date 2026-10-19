import { getSql } from "./client";
import { withTenant, type TenantContext, mapDatabaseError, TenancyError } from "./tenancy";
import { ValidationError, visitorMessageSchema } from "@/lib/validation";
import { logger } from "@/lib/logger";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * ============================================================================
 *  ServiceFront data-access module
 * ============================================================================
 * Everything that talks to Postgres goes through this file. Two consequences:
 *
 *  1. Tenant-scoped reads and writes MUST be called with a TenantContext; the context is
 *     applied to the transaction as `app.current_business_id` / `app.current_user_id` before
 *     any statement runs, so the database's RLS policies decide what is visible. If the
 *     context is missing or wrong the query returns nothing (or the write is rejected) —
 *     it never falls back to "all rows".
 *  2. Rows are written through helpers that inject `business_id` from the context rather than
 *     from caller input, and that reject caller input claiming a different business. An
 *     accidental cross-tenant write therefore has to be deliberate, twice over.
 *
 * Application code imports ONLY from "@/lib/db" — never `postgres` directly, never the pool.
 */

export type ServiceSummary = {
  id: string;
  name: string;
  slug: string;
  category: string | null;
  is_emergency: boolean;
  description: string | null;
};

export type ServiceAreaSummary = {
  id: string;
  name: string;
  city: string | null;
  region: string | null;
  is_primary: boolean;
};

export type FaqSummary = {
  id: string;
  question: string;
  answer: string;
  category: string | null;
};

export type BusinessHoursRow = {
  day_of_week: number;
  opens_at: string | null;
  closes_at: string | null;
  is_closed: boolean;
  appointment_only: boolean;
  note: string | null;
};

export type BusinessProfile = {
  id: string;
  slug: string;
  name: string;
  industry: string;
  timezone: string;
  primary_phone: string | null;
  city: string | null;
  region: string | null;
  emergency_phone: string | null;
  emergency_phone_verified: boolean;
  ai_response_mode: string;
  is_synthetic: boolean;
};

export type ConversationRow = {
  id: string;
  public_id: string;
  channel: string;
  status: string;
  started_at: string;
  message_count: number;
  is_synthetic: boolean;
};

export type LeadSummary = {
  id: string;
  category: string;
  status: string;
  service_interest: string | null;
  is_after_hours: boolean;
  created_at: string;
};

function assertNoForeignBusinessId(context: TenantContext, claimed?: string | null) {
  if (claimed !== undefined && claimed !== null && claimed !== context.businessId) {
    // Second line of defence: the database would reject this too, but failing here keeps the
    // attempt out of the query log entirely.
    throw new TenancyError("cross_tenant_write_attempt", "Refusing to write a row for another business");
  }
}

/* -------------------------------------------------------------------------- */
/* Tenant-scoped reads                                                        */
/* -------------------------------------------------------------------------- */

export async function getBusinessProfile(context: TenantContext): Promise<BusinessProfile | null> {
  return withTenant(context, async (tx) => {
    const rows = (await tx`
      select id, slug, name, industry::text as industry, timezone, primary_phone, city, region,
             emergency_phone, (emergency_phone_verified_at is not null) as emergency_phone_verified,
             ai_response_mode, is_synthetic
      from public.businesses
      where id = ${context.businessId}
      limit 1`) as BusinessProfile[];
    return rows[0] ?? null;
  });
}

export async function listServices(context: TenantContext, opts: { includeInactive?: boolean } = {}) {
  return withTenant(context, async (tx) => {
    const rows = (await tx`
      select id, name, slug, category, is_emergency, description
      from public.services
      where business_id = ${context.businessId}
        and (${opts.includeInactive === true} or is_active)
      order by sort_order, name`) as ServiceSummary[];
    return rows;
  });
}

export async function listServiceAreas(context: TenantContext) {
  return withTenant(context, async (tx) => {
    return (await tx`
      select id, name, city, region, is_primary
      from public.service_areas
      where business_id = ${context.businessId} and is_active
      order by is_primary desc, name`) as ServiceAreaSummary[];
  });
}

export async function listFaqs(context: TenantContext) {
  return withTenant(context, async (tx) => {
    return (await tx`
      select id, question, answer, category
      from public.faqs
      where business_id = ${context.businessId} and is_published
      order by sort_order, question`) as FaqSummary[];
  });
}

export async function listBusinessHours(context: TenantContext) {
  return withTenant(context, async (tx) => {
    return (await tx`
      select day_of_week, opens_at::text, closes_at::text, is_closed, appointment_only, note
      from public.business_hours
      where business_id = ${context.businessId}
      order by day_of_week, opens_at nulls first`) as BusinessHoursRow[];
  });
}

export async function listConversations(context: TenantContext, limit = 50) {
  const safeLimit = Math.min(Math.max(limit, 1), 200);
  return withTenant(context, async (tx) => {
    return (await tx`
      select id, public_id, channel, status, started_at::text, message_count, is_synthetic
      from public.conversations
      where business_id = ${context.businessId}
      order by started_at desc
      limit ${safeLimit}`) as ConversationRow[];
  });
}

export async function listLeads(context: TenantContext, limit = 50) {
  const safeLimit = Math.min(Math.max(limit, 1), 200);
  return withTenant(context, async (tx) => {
    return (await tx`
      select id, category::text as category, status::text as status, service_interest, is_after_hours,
             created_at::text
      from public.leads
      where business_id = ${context.businessId}
      order by created_at desc
      limit ${safeLimit}`) as LeadSummary[];
  });
}

/* -------------------------------------------------------------------------- */
/* Tenant-scoped writes (business_id always comes from the context)           */
/* -------------------------------------------------------------------------- */

export type CreateServiceInput = {
  name: string;
  slug: string;
  description?: string | null;
  category?: string | null;
  isEmergency?: boolean;
  priceNote?: string | null;
  businessId?: string;
};

export async function createService(context: TenantContext, input: CreateServiceInput) {
  assertNoForeignBusinessId(context, input?.businessId);
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  const slug = typeof input?.slug === "string" ? input.slug.trim().toLowerCase() : "";
  if (name.length < 2 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw new ValidationError("name/slug: a service needs a name and a lowercase-hyphenated slug");
  }
  return withTenant(context, async (tx) => {
    try {
      const rows = await tx`
        insert into public.services (business_id, name, slug, description, category, is_emergency, price_note)
        values (${context.businessId}, ${name}, ${slug}, ${input.description ?? null},
                ${input.category ?? null}, ${input.isEmergency === true}, ${input.priceNote ?? null})
        returning id, name, slug`;
      return rows[0] as { id: string; name: string; slug: string };
    } catch (err) {
      return mapDatabaseError(err, "createService");
    }
  });
}

export type StartConversationInput = {
  visitorId?: string;
  channel?: "widget" | "phone" | "email" | "sms";
  pageUrl?: string;
  businessId?: string;
};

export async function startConversation(context: TenantContext, input: StartConversationInput = {}) {
  assertNoForeignBusinessId(context, input?.businessId);
  const visitorId = input.visitorId;
  if (visitorId !== undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(visitorId)) {
    throw new ValidationError("visitorId: must be an opaque pseudonymous id");
  }
  return withTenant(context, async (tx) => {
    try {
      const rows = await tx`
        insert into public.conversations (business_id, visitor_id, channel, page_url, last_message_at)
        values (${context.businessId}, ${visitorId ?? null}, ${input.channel ?? "widget"}, ${input.pageUrl ?? null}, now())
        returning id, public_id, status`;
      return rows[0] as { id: string; public_id: string; status: string };
    } catch (err) {
      return mapDatabaseError(err, "startConversation");
    }
  });
}

/** Appends a visitor message and the answer we gave, and keeps the conversation counters honest. */
export async function appendMessage(
  context: TenantContext,
  input: {
    conversationId: string;
    role: "visitor" | "assistant" | "staff" | "system";
    source: "visitor" | "assistant_demo" | "assistant_live" | "staff" | "system";
    content: string;
    modelName?: string | null;
    answeredFromKnowledge?: boolean | null;
    businessId?: string;
  },
) {
  assertNoForeignBusinessId(context, input?.businessId);
  if (!input?.conversationId) throw new ValidationError("conversationId: required");
  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (content.length < 1 || content.length > 8000) {
    throw new ValidationError("content: must be between 1 and 8000 characters");
  }
  if (input.source === "assistant_live" && !input.modelName) {
    throw new ValidationError("modelName: required when recording a live model answer");
  }
  return withTenant(context, async (tx) => {
    try {
      // The composite FK (conversation_id, business_id) makes it impossible to append to
      // another tenant's conversation even if the id were leaked.
      const rows = await tx`
        insert into public.messages
          (business_id, conversation_id, role, source, content, model_name, answered_from_knowledge)
        values (${context.businessId}, ${input.conversationId}, ${input.role}, ${input.source},
                ${content}, ${input.modelName ?? null}, ${input.answeredFromKnowledge ?? null})
        returning id, created_at`;
      await tx`
        update public.conversations
        set message_count = message_count + 1, last_message_at = now()
        where id = ${input.conversationId} and business_id = ${context.businessId}`;
      const usageEventType = input.role === "visitor" ? "message_received" : "message_answered";
      await tx`
        insert into public.usage_events (business_id, event_type, quantity, unit, conversation_id, idempotency_key)
        values (${context.businessId}, ${usageEventType}::usage_event_type, 1, 'message',
                ${input.conversationId}, ${`msg:${rows[0].id}`})`;
      return rows[0] as { id: string; created_at: string };
    } catch (err) {
      return mapDatabaseError(err, "appendMessage");
    }
  });
}

/** Convenience: validate an inbound widget message at the boundary. */
export function parseVisitorMessage(input: unknown) {
  const parsed = visitorMessageSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "invalid message");
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Context-free, intentionally narrow entry points                            */
/* -------------------------------------------------------------------------- */

export type HealthSnapshot = {
  migrationsApplied: number;
  schemaVersion: number | null;
  tenants: number;
  tenantsSynthetic: number;
  publicTables: number;
  rlsEnabledTables: number;
};

/**
 * Aggregate-only health data. Deliberately has no tenant context: RLS would return zero rows
 * for every tenant table, so this calls a SECURITY DEFINER function that exposes counts only
 * (no names, no emails, no keys).
 */
export async function getHealthSnapshot(): Promise<HealthSnapshot> {
  const sql = getSql();
  try {
    const rows = await sql`select app.health_snapshot() as snapshot`;
    const snapshot = (rows[0]?.snapshot ?? {}) as Record<string, unknown>;
    return {
      migrationsApplied: Number(snapshot.migrations_applied ?? 0),
      schemaVersion: snapshot.schema_version === null ? null : Number(snapshot.schema_version),
      tenants: Number(snapshot.tenants ?? 0),
      tenantsSynthetic: Number(snapshot.tenants_synthetic ?? 0),
      publicTables: Number(snapshot.public_tables ?? 0),
      rlsEnabledTables: Number(snapshot.rls_enabled_tables ?? 0),
    };
  } catch (err) {
    mapDatabaseError(err, "getHealthSnapshot");
  }
}

export type PublicWidgetBusiness = {
  businessId: string;
  slug: string;
  name: string;
  industry: string;
  timezone: string;
  aiResponseMode: string;
  emergencyPhone: string | null;
  emergencyInstructions: string | null;
  isSynthetic: boolean;
};

/**
 * Public widget bootstrap: a public key maps to a fixed, non-sensitive business profile.
 * This is the only context-free read of business data in the codebase, and the function it
 * calls returns a hand-picked field list rather than a row.
 */
export async function resolveWidgetBusiness(publicKey: string): Promise<PublicWidgetBusiness | null> {
  if (typeof publicKey !== "string" || !/^[a-f0-9]{32}$/.test(publicKey)) {
    throw new ValidationError("publicKey: must be a 32-character widget key");
  }
  const sql = getSql();
  const rows = await sql`select app.resolve_widget_business(${publicKey}) as business`;
  const b = rows[0]?.business as Record<string, unknown> | undefined;
  if (!b) return null;
  logger.debug("widget business resolved", { slugKey: String(b.slug ?? "").slice(0, 3) + "***" });
  return {
    businessId: String(b.business_id),
    slug: String(b.slug),
    name: String(b.name),
    industry: String(b.industry),
    timezone: String(b.timezone),
    aiResponseMode: String(b.ai_response_mode),
    emergencyPhone: (b.emergency_phone as string | null) ?? null,
    emergencyInstructions: (b.emergency_instructions as string | null) ?? null,
    isSynthetic: Boolean(b.is_synthetic),
  };
}

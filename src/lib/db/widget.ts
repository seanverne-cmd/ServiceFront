import { createHash } from "node:crypto";
import { getSql } from "./client";
import { withTenant, type TenantContext } from "./tenancy";
import type { KnowledgeBase } from "@/lib/widget/knowledge";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * ============================================================================
 *  Widget data access
 * ============================================================================
 * Two entry points, and the difference between them is the whole security story:
 *
 *  resolveWidgetBusiness()  turns the PUBLIC widget id into a business_id, server-side, using a
 *                           SECURITY DEFINER function that exposes only public fields. The
 *                           client never sends a business_id; it only ever sends an id that is
 *                           already printed in the customer's page source.
 *
 *  withWidgetContext()      runs the widget's own statements in a transaction where
 *                           app.widget_business_id is set to the derived business. The RLS
 *                           policies added in migration 0009 let that session read exactly one
 *                           business's knowledge base and write only that business's
 *                           conversations/messages. app.current_user_id is the nil UUID, so
 *                           every membership-based policy evaluates to false.
 */

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export type WidgetBusiness = {
  businessId: string;
  slug: string;
  name: string;
  industry: string;
  timezone: string;
  aiResponseMode: string;
  safetyPolicy: Record<string, unknown>;
  widgetConfig: {
    welcome_message?: string;
    brand_color?: string;
    assistant_disclosure?: string;
    response_mode?: string;
  };
  allowedOrigins: string[];
  isSynthetic: boolean;
};

export const WIDGET_ID_PATTERN = /^sfw_[a-z0-9]{16,40}$/;

/** Public id -> business. Returns null for an unknown id; never throws details at the caller. */
export async function resolveWidgetBusiness(widgetPublicId: string): Promise<WidgetBusiness | null> {
  const sql = getSql();
  const rows = await sql<{ biz: any }[]>`select app.resolve_widget_business(${widgetPublicId}) as biz`;
  const biz = rows[0]?.biz;
  if (!biz) return null;
  return {
    businessId: biz.business_id,
    slug: biz.slug,
    name: biz.name,
    industry: biz.industry,
    timezone: biz.timezone,
    aiResponseMode: biz.ai_response_mode,
    safetyPolicy: biz.ai_safety_policy ?? {},
    widgetConfig: biz.widget_config ?? {},
    allowedOrigins: Array.isArray(biz.widget_allowed_origins) ? biz.widget_allowed_origins : [],
    isSynthetic: Boolean(biz.is_synthetic),
  };
}

export async function withWidgetContext<T>(businessId: string, fn: (tx: any) => Promise<T>): Promise<T> {
  const sql = getSql();
  return (await sql.begin(async (tx: any) => {
    await tx`select set_config('app.current_business_id', ${businessId}, true)`;
    await tx`select set_config('app.current_user_id', ${NIL_UUID}, true)`;
    await tx`select set_config('app.widget_business_id', ${businessId}, true)`;
    return await fn(tx);
  })) as T;
}

/**
 * A pseudonymous visitor id derived from the client, the widget and a server secret.
 * It is never the IP address itself, and it is what binds a conversation to the browser that
 * started it: a conversationId from another visitor cannot be appended to.
 */
export function deriveVisitorId(clientHash: string, widgetPublicId: string): string {
  const secret = process.env.SESSION_SECRET ?? "dev-only-insecure-session-secret";
  return "v" + createHash("sha256").update(`${clientHash}:${widgetPublicId}:${secret}`).digest("hex").slice(0, 40);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Load the business's approved facts. RLS-scoped: another tenant's rows are simply not here. */
export async function loadKnowledge(tx: any, businessId: string): Promise<KnowledgeBase | null> {
  const [biz] = await tx`
    select id, name, industry::text as industry, timezone, primary_phone, primary_email, website_url,
           address_line1, address_line2, city, region, postal_code,
           emergency_phone, (emergency_phone_verified_at is not null) as emergency_phone_verified,
           emergency_instructions, ai_response_mode, ai_safety_policy, is_synthetic
    from public.businesses
    where id = ${businessId}`;
  if (!biz) return null;

  const hours = await tx`
    select id, day_of_week, opens_at::text as opens_at, closes_at::text as closes_at,
           is_closed, appointment_only, note
    from public.business_hours
    where business_id = ${businessId}
    order by day_of_week, opens_at nulls first`;

  const services = await tx`
    select id, slug, name, description, category, is_emergency, price_note
    from public.services
    where business_id = ${businessId} and is_active
    order by sort_order, name`;

  const areas = await tx`
    select id, name, city, region, postal_code, is_primary, travel_note
    from public.service_areas
    where business_id = ${businessId} and is_active
    order by is_primary desc, name`;

  const faqs = await tx`
    select id, question, answer, category
    from public.faqs
    where business_id = ${businessId} and is_published
    order by sort_order, question`;

  return {
    business: {
      id: biz.id,
      name: biz.name,
      industry: biz.industry,
      timezone: biz.timezone,
      primaryPhone: biz.primary_phone,
      primaryEmail: biz.primary_email,
      websiteUrl: biz.website_url,
      addressLine1: biz.address_line1,
      addressLine2: biz.address_line2,
      city: biz.city,
      region: biz.region,
      postalCode: biz.postal_code,
      emergencyPhone: biz.emergency_phone,
      emergencyPhoneVerified: Boolean(biz.emergency_phone_verified),
      emergencyInstructions: biz.emergency_instructions,
      aiResponseMode: biz.ai_response_mode,
      safetyPolicy: biz.ai_safety_policy ?? {},
      isSynthetic: Boolean(biz.is_synthetic),
    },
    hours: hours.map((h: any) => ({
      id: h.id,
      dayOfWeek: Number(h.day_of_week),
      opensAt: h.opens_at,
      closesAt: h.closes_at,
      isClosed: h.is_closed,
      appointmentOnly: h.appointment_only,
      note: h.note,
    })),
    services: services.map((s: any) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      description: s.description,
      category: s.category,
      isEmergency: s.is_emergency,
      priceNote: s.price_note,
    })),
    areas: areas.map((a: any) => ({
      id: a.id,
      name: a.name,
      city: a.city,
      region: a.region,
      postalCode: a.postal_code,
      isPrimary: a.is_primary,
      travelNote: a.travel_note,
    })),
    faqs: faqs.map((f: any) => ({ id: f.id, question: f.question, answer: f.answer, category: f.category })),
  };
}

export type OpenConversationInput = {
  businessId: string;
  conversationId?: string;
  visitorId: string;
  pageUrl: string | null;
  referrer: string | null;
  userAgentFamily: string | null;
  visitorIpHash: string | null;
  isSynthetic: boolean;
  syntheticBatch: string | null;
};

/**
 * Find the caller's own conversation, or create one. A conversationId that belongs to another
 * business or another visitor returns `null` — the endpoint answers with a safe 404 and creates
 * nothing.
 */
export async function openConversation(tx: any, input: OpenConversationInput): Promise<string | null> {
  if (input.conversationId) {
    const [row] = await tx`
      update public.conversations
         set last_message_at = now()
       where id = ${input.conversationId}
         and business_id = ${input.businessId}
         and visitor_id = ${input.visitorId}
      returning id`;
    return row?.id ?? null;
  }
  const [row] = await tx`
    insert into public.conversations
      (business_id, visitor_id, channel, status, page_url, referrer, user_agent_family,
       visitor_ip_hash, last_message_at, message_count, is_synthetic, synthetic_batch)
    values
      (${input.businessId}, ${input.visitorId}, 'widget', 'open', ${input.pageUrl}, ${input.referrer},
       ${input.userAgentFamily}, ${input.visitorIpHash}, now(), 0, ${input.isSynthetic}, ${input.syntheticBatch})
    returning id`;
  return row?.id ?? null;
}

export type ExchangeInput = {
  businessId: string;
  conversationId: string;
  visitorText: string;
  replyText: string;
  mode: "demo" | "live";
  answeredFromKnowledge: boolean;
  factRefs: string[];
  confidence: number;
  intent: string;
  modelProvider: string | null;
  modelName: string | null;
  latencyMs: number | null;
  isSynthetic: boolean;
  syntheticBatch: string | null;
};

/**
 * Cited knowledge sources come back from jsonb in three shapes: a string[], a JSON string of one
 * (older rows), or a double-encoded JSON string. Anything else is "no citations". Reading through
 * this is what keeps a transcript honest: an answer that cited a service record must show it.
 */
export function normalizeFactRefs(value: unknown): string[] {
  let v: unknown = value;
  for (let i = 0; i < 4 && typeof v === "string"; i += 1) {
    try { v = JSON.parse(v); } catch { return []; }
  }
  if (!Array.isArray(v)) return [];
  return v.map((f) => String(f)).filter(Boolean);
}

/** Store the visitor message and the assistant reply as one atomic exchange. */
export async function appendExchange(tx: any, input: ExchangeInput): Promise<void> {
  const assistantSource = input.mode === "live" ? "assistant_live" : "assistant_demo";
  await tx`
    insert into public.messages
      (business_id, conversation_id, role, source, content, content_sha256,
       answered_from_knowledge, cited_fact_refs, confidence, intent,
       model_provider, model_name, latency_ms,
       is_synthetic, synthetic_batch)
    values
      (${input.businessId}, ${input.conversationId}, 'visitor', 'visitor', ${input.visitorText}, ${sha256(input.visitorText)},
       null, '[]'::jsonb, null, null, null, null, null, ${input.isSynthetic}, ${input.syntheticBatch}),
      (${input.businessId}, ${input.conversationId}, 'assistant', ${assistantSource}::message_source, ${input.replyText}, ${sha256(input.replyText)},
       ${input.answeredFromKnowledge}, ${JSON.stringify(normalizeFactRefs(input.factRefs))}::jsonb, ${input.confidence}, ${input.intent},
       ${input.mode === "live" ? input.modelProvider : null},
       ${input.mode === "live" ? input.modelName : null},
       ${input.latencyMs}, ${input.isSynthetic}, ${input.syntheticBatch})`;

  await tx`
    update public.conversations
       set message_count = message_count + 2,
           last_message_at = now()
     where id = ${input.conversationId} and business_id = ${input.businessId}`;
}

/* -------------------------------------------------------------------------- */
/*  Dashboard (authenticated) read-only views — RLS via withTenant             */
/* -------------------------------------------------------------------------- */

export type ConversationListItem = {
  id: string;
  visitorId: string | null;
  status: string;
  startedAt: string;
  lastMessageAt: string | null;
  messageCount: number;
  preview: string;
  intent: string | null;
  outcome: string;
  modeLabel: string;
  hasLiveAnswer: boolean;
  isSynthetic: boolean;
};

export type StoredMessage = {
  id: string;
  role: string;
  source: string;
  content: string;
  answeredFromKnowledge: boolean | null;
  intent: string | null;
  factRefs: string[];
  confidence: number | null;
  modelName: string | null;
  createdAt: string;
  modeLabel: string;
};

export function modeLabel(source: string): string {
  switch (source) {
    case "assistant_demo":
      return "Demo mode — deterministic reply from approved facts (not a live AI model)";
    case "assistant_live":
      return "Live model reply — checked against approved facts";
    case "visitor":
      return "Visitor";
    default:
      return source;
  }
}

/**
 * What happened in the conversation, in the owner's terms. Derived from the LAST assistant
 * message rather than stored separately, so it can never drift from the transcript.
 */
function outcomeLabel(answeredFromKnowledge: boolean | null, hasAssistant: boolean, status: string): string {
  if (!hasAssistant) return status === "open" ? "No reply yet" : `No reply (${status})`;
  const answer = answeredFromKnowledge
    ? "Answered from approved facts"
    : "No confirmed answer — visitor referred on";
  return status === "open" ? answer : `${answer} · conversation ${status}`;
}

export async function listConversations(context: TenantContext, limit = 50): Promise<ConversationListItem[]> {
  return withTenant(context, async (tx) => {
    const rows = await tx`
      select c.id, c.visitor_id, c.status::text as status, c.started_at, c.last_message_at,
             c.message_count, c.is_synthetic,
             coalesce(
               (select m.content from public.messages m
                 where m.conversation_id = c.id and m.role = 'visitor'
                 order by m.created_at limit 1),
               ''
             ) as preview,
             (select m2.source::text from public.messages m2
               where m2.conversation_id = c.id and m2.role = 'assistant'
               order by m2.created_at desc, m2.id desc limit 1) as last_source,
             (select m3.intent from public.messages m3
               where m3.conversation_id = c.id and m3.role = 'assistant'
               order by m3.created_at desc, m3.id desc limit 1) as last_intent,
             (select m4.answered_from_knowledge from public.messages m4
               where m4.conversation_id = c.id and m4.role = 'assistant'
               order by m4.created_at desc, m4.id desc limit 1) as last_grounded
      from public.conversations c
      where c.business_id = ${context.businessId}
      order by coalesce(c.last_message_at, c.started_at) desc
      limit ${limit}`;
    return rows.map((r: any) => ({
      id: r.id,
      visitorId: r.visitor_id ?? null,
      status: String(r.status),
      startedAt: r.started_at.toISOString?.() ?? String(r.started_at),
      lastMessageAt: r.last_message_at ? (r.last_message_at.toISOString?.() ?? String(r.last_message_at)) : null,
      messageCount: Number(r.message_count),
      preview: String(r.preview).slice(0, 140),
      intent: r.last_intent ?? null,
      outcome: outcomeLabel(
        r.last_grounded === null || r.last_grounded === undefined ? null : Boolean(r.last_grounded),
        Boolean(r.last_source),
        String(r.status),
      ),
      modeLabel: r.last_source ? modeLabel(String(r.last_source)) : "No assistant reply yet",
      hasLiveAnswer: r.last_source === "assistant_live",
      isSynthetic: Boolean(r.is_synthetic),
    }));
  });
}

export async function getConversation(
  context: TenantContext,
  conversationId: string,
): Promise<{
  id: string;
  status: string;
  visitorId: string | null;
  startedAt: string;
  lastMessageAt: string | null;
  isSynthetic: boolean;
  messages: StoredMessage[];
} | null> {
  return withTenant(context, async (tx) => {
    const [conv] = await tx`
      select id, status::text as status, visitor_id, started_at, last_message_at, is_synthetic
        from public.conversations
       where id = ${conversationId} and business_id = ${context.businessId}`;
    if (!conv) return null;
    const rows = await tx`
      select id, role::text as role, source::text as source, content, answered_from_knowledge,
             intent, cited_fact_refs, confidence, model_name, created_at
      from public.messages
      where conversation_id = ${conversationId} and business_id = ${context.businessId}
      order by created_at, id`;
    return {
      id: conv.id,
      status: String(conv.status),
      visitorId: conv.visitor_id ?? null,
      startedAt: conv.started_at.toISOString?.() ?? String(conv.started_at),
      lastMessageAt: conv.last_message_at
        ? (conv.last_message_at.toISOString?.() ?? String(conv.last_message_at))
        : null,
      isSynthetic: Boolean(conv.is_synthetic),
      messages: rows.map((m: any) => ({
        id: m.id,
        role: m.role,
        source: m.source,
        content: m.content,
        answeredFromKnowledge: m.answered_from_knowledge,
        intent: m.intent ?? null,
        factRefs: normalizeFactRefs(m.cited_fact_refs),
        confidence: m.confidence === null || m.confidence === undefined ? null : Number(m.confidence),
        modelName: m.model_name ?? null,
        createdAt: m.created_at.toISOString?.() ?? String(m.created_at),
        modeLabel: modeLabel(m.source),
      })),
    };
  });
}

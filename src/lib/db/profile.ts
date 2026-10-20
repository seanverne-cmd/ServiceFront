import { withTenant, withTenantTransaction, type TenantContext } from "./tenancy";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Business profile read/write. Reads go through `withTenant` (RLS applies); the update runs
 * inside one transaction that also writes the before/after audit entry, so a profile change and
 * its audit trail can never be split.
 */

export type BusinessProfileDetail = {
  id: string;
  slug: string;
  name: string;
  industry: string;
  timezone: string;
  primary_email: string | null;
  primary_phone: string | null;
  website_url: string | null;
  address_line1: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  emergency_phone: string | null;
  emergency_phone_verified: boolean;
  public_welcome_message: string | null;
  hours_summary: string | null;
  ai_response_mode: string;
  is_synthetic: boolean;
};

export type BusinessProfileUpdate = {
  name: string;
  industry: string;
  website_url: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  city: string | null;
  region: string | null;
  public_welcome_message: string | null;
  hours_summary: string | null;
};

const PROFILE_COLUMNS = `
  id, slug, name, industry::text as industry, timezone, primary_email, primary_phone,
  website_url, address_line1, city, region, postal_code, emergency_phone,
  (emergency_phone_verified_at is not null) as emergency_phone_verified,
  public_welcome_message, hours_summary, ai_response_mode, is_synthetic`;

export async function getBusinessProfileDetail(context: TenantContext): Promise<BusinessProfileDetail | null> {
  return withTenant(context, async (tx) => {
    const rows = (await tx`
      select ${tx.unsafe(PROFILE_COLUMNS)}
      from public.businesses
      where id = ${context.businessId}
      limit 1`) as BusinessProfileDetail[];
    return rows[0] ?? null;
  });
}

export async function updateBusinessProfile(
  context: TenantContext,
  input: BusinessProfileUpdate,
  actorRole: "business_owner" | "business_staff",
): Promise<{ before: BusinessProfileDetail; after: BusinessProfileDetail }> {
  return withTenantTransaction(context, async (tx) => {
    const beforeRows = (await tx`
      select ${tx.unsafe(PROFILE_COLUMNS)}
      from public.businesses
      where id = ${context.businessId}
      limit 1`) as BusinessProfileDetail[];
    const before = beforeRows[0];
    if (!before) throw new Error("business_not_visible");

    // The business id comes from the tenant context, never from the caller, so this statement
    // cannot touch another tenant's row even if the form were tampered with.
    const updatedRows = (await tx`
      update public.businesses set
        name = ${input.name},
        industry = ${input.industry}::industry,
        website_url = ${input.website_url},
        primary_email = ${input.primary_email},
        primary_phone = ${input.primary_phone},
        city = ${input.city},
        region = ${input.region},
        public_welcome_message = ${input.public_welcome_message},
        hours_summary = ${input.hours_summary}
      where id = ${context.businessId}
      returning ${tx.unsafe(PROFILE_COLUMNS)}`) as BusinessProfileDetail[];
    const after = updatedRows[0];
    if (!after) throw new Error("profile_update_refused_by_rls");

    // Audit: changed fields only, before/after, no secrets and no customer PII.
    const changed: Record<string, { before: unknown; after: unknown }> = {};
    for (const key of Object.keys(input) as (keyof BusinessProfileUpdate)[]) {
      if ((before as any)[key] !== (after as any)[key]) {
        changed[key] = { before: (before as any)[key], after: (after as any)[key] };
      }
    }

    if (Object.keys(changed).length > 0) {
      await tx`
        insert into public.audit_logs
          (business_id, actor_user_id, actor_role, action, target_type, target_id, metadata, is_synthetic)
        values (
          ${context.businessId}, ${context.userId}, ${actorRole}, 'business.updated',
          'business', ${context.businessId},
          ${ { changed_fields: Object.keys(changed), changes: changed } }, false
        )`;
    }

    return { before, after };
  });
}

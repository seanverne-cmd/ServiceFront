-- 0002_tenancy_core.sql
-- ServiceFront foundation migration 2 of 7: the two tables that define tenancy.
--
-- Conventions used by every tenant-owned table in this schema:
--   * business_id uuid not null references businesses(id) on delete cascade  + an index
--   * is_synthetic / synthetic_batch  -> demo data is flagged in the schema, not just by name
--   * created_at / updated_at (updated_at maintained by trigger app.set_updated_at)
-- The FK to businesses(id) plus the RLS policies in 0006 are what make a row
-- impossible to read or write outside its tenant.

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  name text not null,
  industry industry not null,
  timezone text not null default 'America/Los_Angeles',

  -- contact details
  primary_email text,
  primary_phone text,
  website_url text,
  address_line1 text,
  address_line2 text,
  city text,
  region text,
  postal_code text,
  country_code char(2) not null default 'US',

  -- "verified emergency contact method": a number we confirmed with the business.
  -- The pairing is enforced: an unverified number cannot be stored at all.
  emergency_phone text,
  emergency_phone_verified_at timestamptz,
  emergency_instructions text,

  -- public widget identity (safe to expose in a customer's page source)
  widget_public_key text not null default md5(gen_random_uuid()::text || clock_timestamp()::text),

  -- AI behaviour configuration. 'demo' is a deterministic, clearly-labelled response
  -- mode used when no live LLM credentials exist; it never claims to be a live model.
  ai_response_mode text not null default 'demo',
  ai_safety_policy jsonb not null default '{}'::jsonb,

  -- Platform-admin access to this tenant's data is off unless explicitly switched on,
  -- and every use of it is written to audit_logs.
  support_access_enabled boolean not null default false,
  retention_days integer not null default 365,

  is_synthetic boolean not null default false,
  synthetic_batch text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint businesses_slug_key unique (slug),
  constraint businesses_widget_public_key_key unique (widget_public_key),
  constraint businesses_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint businesses_name_len check (char_length(name) between 2 and 200),
  constraint businesses_ai_response_mode check (ai_response_mode in ('demo', 'live')),
  constraint businesses_retention_days check (retention_days between 1 and 3650),
  constraint businesses_email_format check (
    primary_email is null or primary_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  constraint businesses_phone_format check (primary_phone is null or primary_phone ~ '^[0-9+()\-.\s]{7,32}$'),
  constraint businesses_emergency_phone_format check (
    emergency_phone is null or emergency_phone ~ '^[0-9+()\-.\s]{7,32}$'
  ),
  -- no unverified emergency contact may exist
  constraint businesses_emergency_contact_verified check (
    emergency_phone is null or emergency_phone_verified_at is not null
  ),
  -- a veterinary tenant may not be created without its safety constraints stored
  constraint businesses_vet_safety_policy check (
    industry <> 'veterinary' or (
      coalesce((ai_safety_policy ->> 'no_diagnosis')::boolean, false)
      and coalesce((ai_safety_policy ->> 'no_medication_doses')::boolean, false)
      and coalesce((ai_safety_policy ->> 'no_individualized_treatment')::boolean, false)
      and coalesce((ai_safety_policy ->> 'never_claim_vet_review')::boolean, false)
      and coalesce((ai_safety_policy ->> 'no_emergency_triage')::boolean, false)
      and coalesce((ai_safety_policy ->> 'no_appointment_confirmation')::boolean, false)
      and coalesce((ai_safety_policy ->> 'no_refill_confirmation')::boolean, false)
    )
  ),
  -- synthetic rows must say which demo batch they came from
  constraint businesses_synthetic_labelled check (not is_synthetic or synthetic_batch is not null)
);

comment on column public.businesses.is_synthetic is 'TRUE for fictional demonstration tenants; real customers are always FALSE.';
comment on column public.businesses.ai_safety_policy is 'Machine-readable AI guardrails per industry (see docs/DATA_MODEL.md).';
comment on column public.businesses.widget_public_key is 'Public, embeddable identifier for the chat widget. Not a secret.';

create index businesses_industry_idx on public.businesses (industry);
create index businesses_synthetic_idx on public.businesses (is_synthetic);

create trigger businesses_set_updated_at
  before update on public.businesses
  for each row execute function app.set_updated_at();

create table public.business_members (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  -- the identity provider's user id (hosted auth). No passwords are ever stored here.
  user_id uuid not null,
  role member_role not null,
  status text not null default 'active',
  email text,
  display_name text,
  invited_by_user_id uuid,
  is_synthetic boolean not null default false,
  synthetic_batch text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint business_members_business_user_key unique (business_id, user_id),
  constraint business_members_status check (status in ('active', 'invited', 'revoked')),
  -- platform_admin is an out-of-tenant role and must live in platform_admins, so that
  -- every row of this table belongs to exactly one tenant and RLS stays simple.
  constraint business_members_not_platform_admin check (role <> 'platform_admin'),
  constraint business_members_email_format check (
    email is null or email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  constraint business_members_synthetic_labelled check (not is_synthetic or synthetic_batch is not null)
);

create index business_members_business_id_idx on public.business_members (business_id);
create index business_members_user_id_idx on public.business_members (user_id);

create trigger business_members_set_updated_at
  before update on public.business_members
  for each row execute function app.set_updated_at();

-- Platform admins are deliberately NOT tenant rows: they hold no membership anywhere,
-- which is why they cannot see tenant data without the explicit support opt-in (0006).
create table public.platform_admins (
  user_id uuid primary key,
  granted_by_user_id uuid,
  note text,
  is_synthetic boolean not null default false,
  synthetic_batch text,
  created_at timestamptz not null default now(),
  constraint platform_admins_synthetic_labelled check (not is_synthetic or synthetic_batch is not null)
);

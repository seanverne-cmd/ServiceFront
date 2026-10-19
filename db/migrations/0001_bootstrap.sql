-- 0001_bootstrap.sql
-- ServiceFront foundation migration 1 of 7.
-- Plain standard SQL that runs unchanged on a local PostgreSQL 14+ server and on hosted Supabase.
-- No extensions are required (gen_random_uuid() is built in from PostgreSQL 13).

create schema if not exists app;
comment on schema app is 'ServiceFront internal helpers: tenancy context readers, trigger helpers, health snapshot.';

-- ---------------------------------------------------------------------------
-- Shared trigger helper: keep updated_at honest without trusting the caller.
-- ---------------------------------------------------------------------------
create or replace function app.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Session tenancy context.
--
-- The application sets these per request/transaction with
--   select set_config('app.current_business_id', $1, true)   -- true = SET LOCAL
--   select set_config('app.current_user_id',     $2, true)
-- They are transaction-local, so they cannot leak between pooled connections.
-- Reading with missing_ok = true means an unset value is NULL, never an error,
-- and every RLS policy below evaluates to false on NULL -> a context-less
-- query returns zero rows instead of everybody's rows.
-- ---------------------------------------------------------------------------
create or replace function app.current_business_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.current_business_id', true), '')::uuid
$$;

create or replace function app.current_user_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

-- Platform-admin ("support") access is OFF by default and needs a second,
-- explicit per-session opt-in in addition to a row in platform_admins.
create or replace function app.support_access_enabled()
returns boolean
language sql
stable
as $$
  select lower(coalesce(current_setting('app.support_access', true), '')) in ('on', 'true', '1')
$$;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
create type industry as enum ('plumbing', 'veterinary', 'hvac', 'electrical', 'roofing', 'other');
create type member_role as enum ('platform_admin', 'business_owner', 'business_staff');
create type conversation_status as enum ('open', 'closed', 'spam', 'abandoned');
create type message_role as enum ('visitor', 'assistant', 'staff', 'system');
create type message_source as enum ('visitor', 'assistant_demo', 'assistant_live', 'staff', 'system');
create type lead_category as enum (
  'service_request', 'appointment_request', 'quote_request', 'emergency',
  'general_enquiry', 'existing_customer', 'vendor', 'spam'
);
create type lead_status as enum ('new', 'contacted', 'qualified', 'scheduled', 'won', 'lost', 'archived');
create type notification_channel as enum ('email', 'sms', 'in_app');
create type notification_status as enum ('pending', 'sent', 'failed', 'read');
create type usage_event_type as enum (
  'conversation_started', 'message_received', 'message_answered',
  'lead_captured', 'widget_embed_served', 'llm_tokens', 'storage_retention_pass'
);
create type audit_action as enum (
  'business.created', 'business.updated', 'member.invited', 'member.role_changed',
  'member.revoked', 'support_access.granted', 'support_access.used',
  'lead.status_changed', 'data.exported', 'migration.applied', 'seed.loaded'
);

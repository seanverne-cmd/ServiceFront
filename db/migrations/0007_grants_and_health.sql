-- 0007_grants_and_health.sql
-- ServiceFront foundation migration 7 of 7: application privileges and the two
-- narrowly-scoped SECURITY DEFINER entry points the app needs without a tenant context.
--
-- PRIVILEGE MODEL
--   * tables/sequences are owned by the migrator role (locally: servicefront_owner)
--   * the running application connects as a DIFFERENT, non-owner role (locally: servicefront_app)
--     which has table privileges but no way to bypass RLS
--   * ownership + FORCE ROW LEVEL SECURITY (0006) means even the owner is policed, and the
--     BYPASSRLS owner is what the SECURITY DEFINER helpers run as
-- On hosted Supabase the same two roles are `authenticated` (app) and `postgres`/service role
-- (migrations). The grants below are skipped cleanly when the local role does not exist.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'servicefront_app') then
    execute 'grant usage on schema public to servicefront_app';
    execute 'grant usage on schema app to servicefront_app';
    execute 'grant select, insert, update, delete on all tables in schema public to servicefront_app';
    execute 'grant usage, select on all sequences in schema public to servicefront_app';
    execute 'revoke all on schema app from public';
    execute 'grant usage on schema app to servicefront_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'servicefront_migrator') then
    execute 'grant usage on schema public to servicefront_migrator';
  end if;
exception
  when insufficient_privilege then
    raise notice 'skipping local role grants (insufficient privilege on this server)';
end $$;

-- ---------------------------------------------------------------------------
-- Widget bootstrap: resolve a public widget key to the (non-sensitive) business profile.
-- The public widget has NO tenant session and therefore sees nothing through RLS; it calls
-- this function instead, which returns a fixed, deliberately small set of public fields.
-- Nothing here is private: the widget key is already in the customer's page source.
-- ---------------------------------------------------------------------------
create or replace function app.resolve_widget_business(p_public_key text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select jsonb_build_object(
    'business_id', b.id,
    'slug', b.slug,
    'name', b.name,
    'industry', b.industry::text,
    'timezone', b.timezone,
    'ai_response_mode', b.ai_response_mode,
    'emergency_phone', b.emergency_phone,
    'emergency_instructions', b.emergency_instructions,
    'is_synthetic', b.is_synthetic
  )
  from public.businesses b
  where b.widget_public_key = nullif(trim(p_public_key), '')
    and b.widget_public_key is not null
  limit 1
$$;

-- ---------------------------------------------------------------------------
-- Health snapshot: aggregate counts only. No names, no emails, no keys, no row data.
-- Runs as the owner so that a context-less health check can report real numbers
-- without any permissive policy being added to tenant tables.
-- ---------------------------------------------------------------------------
create or replace function app.health_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select jsonb_build_object(
    'migrations_applied', (select count(*) from public.schema_migrations),
    'schema_version', (select max(version) from public.schema_migrations),
    'tenants', (select count(*) from public.businesses),
    'tenants_synthetic', (select count(*) from public.businesses where is_synthetic),
    'public_tables', (
      select count(*) from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    ),
    'rls_enabled_tables', (
      select count(*) from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and (c.relrowsecurity or c.relforcerowsecurity)
    )
  )
$$;

do $$
begin
  execute 'grant execute on function app.resolve_widget_business(text) to public';
  execute 'grant execute on function app.health_snapshot() to public';
exception when insufficient_privilege then
  raise notice 'skipping function grants';
end $$;

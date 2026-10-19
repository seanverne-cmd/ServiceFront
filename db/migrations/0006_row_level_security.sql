-- 0006_row_level_security.sql
-- ServiceFront foundation migration 6 of 7: RLS is the tenancy boundary.
--
-- HOW A QUERY IS SCOPED
--   1. The application opens a transaction and sets the session context, once:
--        select set_config('app.current_business_id', '<uuid>', true);
--        select set_config('app.current_user_id',     '<uuid>', true);
--   2. Every tenant policy below answers "may this session touch this row?" by asking the
--      database, not the client: the row's business_id must equal the session's business id
--      AND the session's user id must hold an active membership in that business.
--   3. With no context set, current_setting(..., true) yields NULL, every helper returns
--      NULL/false, and the policy predicate is false: the query returns zero rows and writes
--      are rejected. It fails closed, never open.
--
-- WHY THE HELPERS ARE SECURITY DEFINER
--   They read business_members / platform_admins while those tables are themselves protected
--   by RLS. Running as the schema owner (which holds BYPASSRLS) keeps the membership lookup
--   out of the policy evaluation, which both avoids recursive policy evaluation and makes the
--   lookup independent of whatever the caller is allowed to see. search_path is pinned.
--
-- NOTE ON SUPPORT ACCESS
--   Platform admins are read-only by construction: can_access_tenant() grants SELECT, while
--   every INSERT/UPDATE/DELETE policy additionally requires a real membership, so a support
--   session can never mutate a tenant's data.

create or replace function app.member_role_for(p_business_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select m.role::text
  from public.business_members m
  where m.business_id = p_business_id
    and m.user_id = app.current_user_id()
    and m.status = 'active'
  limit 1
$$;

create or replace function app.is_tenant_member(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select p_business_id is not null and app.member_role_for(p_business_id) is not null
$$;

create or replace function app.is_business_owner(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select app.member_role_for(p_business_id) = 'business_owner'
$$;

create or replace function app.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select app.support_access_enabled()
     and app.current_user_id() is not null
     and exists (
       select 1 from public.platform_admins pa where pa.user_id = app.current_user_id()
     )
$$;

-- READ access: a member of the session's business, or a platform admin with support access on.
create or replace function app.can_access_tenant(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select p_business_id is not null
     and (
       app.is_platform_admin()
       or (p_business_id = app.current_business_id() and app.is_tenant_member(p_business_id))
     )
$$;

-- WRITE access: only a genuine, active member of the session's business. Never a support/admin session.
create or replace function app.can_write_tenant(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select p_business_id is not null
     and p_business_id = app.current_business_id()
     and app.is_tenant_member(p_business_id)
$$;

-- ---------------------------------------------------------------------------
-- businesses  (tenant key column: id)
-- ---------------------------------------------------------------------------
alter table public.businesses enable row level security;
alter table public.businesses force row level security;

create policy businesses_select_tenant on public.businesses for select
  using (app.can_access_tenant(id));
create policy businesses_update_owner on public.businesses for update
  using (app.is_business_owner(id) and id = app.current_business_id())
  with check (app.is_business_owner(id) and id = app.current_business_id());
-- No INSERT/DELETE policy: tenants are provisioned by the server (migration/onboarding role).
-- Their absence means a tenant session cannot create or delete a business at all.

-- ---------------------------------------------------------------------------
-- business_members  (a member of a business may read its roster; only owners may change it)
-- ---------------------------------------------------------------------------
alter table public.business_members enable row level security;
alter table public.business_members force row level security;

create policy business_members_select_tenant on public.business_members for select
  using (app.can_access_tenant(business_id));
create policy business_members_insert_owner on public.business_members for insert
  with check (app.can_write_tenant(business_id) and app.is_business_owner(business_id));
create policy business_members_update_owner on public.business_members for update
  using (app.can_write_tenant(business_id) and app.is_business_owner(business_id))
  with check (app.can_write_tenant(business_id) and app.is_business_owner(business_id));
create policy business_members_delete_owner on public.business_members for delete
  using (app.can_write_tenant(business_id) and app.is_business_owner(business_id));

-- ---------------------------------------------------------------------------
-- platform_admins
--   Not tenant-owned (no business_id by design). Readable only through
--   app.is_platform_admin(), which already requires support access to be switched on.
--   The table is written by the server owner role only; no policy grants writes.
-- ---------------------------------------------------------------------------
alter table public.platform_admins enable row level security;

create policy platform_admins_select_support on public.platform_admins for select
  using (app.is_platform_admin());

-- ---------------------------------------------------------------------------
-- Tenant-owned data tables (identical shape: read = member or support, write = member)
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'services', 'service_areas', 'faqs', 'business_hours',
    'conversations', 'messages', 'leads', 'lead_status_history',
    'notifications', 'usage_events', 'audit_logs'
  ];
begin
  foreach t in array tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format(
      'create policy %I on public.%I for select using (app.can_access_tenant(business_id))',
      t || '_select_tenant', t);
    execute format(
      'create policy %I on public.%I for insert with check (app.can_write_tenant(business_id))',
      t || '_insert_tenant', t);
    execute format(
      'create policy %I on public.%I for update using (app.can_write_tenant(business_id)) with check (app.can_write_tenant(business_id))',
      t || '_update_tenant', t);
    execute format(
      'create policy %I on public.%I for delete using (app.can_write_tenant(business_id))',
      t || '_delete_tenant', t);
  end loop;
end $$;

-- audit_logs is append-only: writing a new entry is allowed, editing or erasing history is not.
drop policy audit_logs_update_tenant on public.audit_logs;
drop policy audit_logs_delete_tenant on public.audit_logs;
-- A support session may read tenant data, so it must be able to record that it did:
create policy audit_logs_insert_support on public.audit_logs for insert
  with check (app.can_access_tenant(business_id));
drop policy audit_logs_insert_tenant on public.audit_logs;

comment on function app.can_access_tenant(uuid) is 'SELECT-side tenancy predicate: own business + active membership, or explicit support access.';
comment on function app.can_write_tenant(uuid) is 'WRITE-side tenancy predicate: own business + active membership. Never satisfied without session context.';

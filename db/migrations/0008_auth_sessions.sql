-- 0008_auth_sessions.sql
-- ServiceFront migration 8: dashboard identity (users + server-side sessions), the two
-- business-profile fields the owner edits in the dashboard, and the audit actions for sign-in.
--
-- DESIGN NOTES
--   * Passwords are stored ONLY as a self-describing KDF string produced by
--     src/lib/auth/password.ts (scrypt with a per-password random salt). Never plaintext,
--     never a fast hash such as sha256/md5.
--   * `sessions` holds a SHA-256 hash of the opaque cookie token, never the token itself, so a
--     database read cannot be replayed as a login.
--   * `users` and `sessions` are NOT tenant tables: a sign-in has to be looked up before any
--     business is known. They therefore get RLS enabled with FORCE and NO policies, so the
--     application role cannot read them directly at all. The auth flow goes through the
--     narrowly-scoped SECURITY DEFINER functions at the bottom of this file.
--   * Every function below is `security definer set search_path = public, pg_catalog` and is
--     granted only to the app role.
--
-- HOSTED-AUTH MIGRATION POINT
--   If the owner later moves to hosted Supabase Auth, the only app code that changes is
--   src/lib/auth/session.ts (plus src/lib/db/auth.ts): the cookie/verification layer is
--   replaced by Supabase's JWT verification and `getSessionUser()` returns the `sub` claim
--   instead of the local `users.id`. `business_members.user_id` already stores "the identity
--   provider's user id" (see 0002), so the tenancy model, RLS policies and every page stay
--   exactly as they are. On hosted auth, `app.auth_*` below and the `users`/`sessions` tables
--   are dropped and replaced by `auth.users` / `auth.sessions`.

-- ---------------------------------------------------------------------------
-- Audit actions for the authentication flow (append-only enum)
-- ---------------------------------------------------------------------------
alter type audit_action add value if not exists 'auth.signed_in';
alter type audit_action add value if not exists 'auth.signed_out';
alter type audit_action add value if not exists 'auth.sign_in_failed';

-- ---------------------------------------------------------------------------
-- Users (dashboard identities)
-- ---------------------------------------------------------------------------
create table public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  -- KDF string: scrypt$N$r$p$<salt-b64>$<hash-b64>. See src/lib/auth/password.ts.
  password_hash text not null,
  display_name text,
  status text not null default 'active',
  last_signed_in_at timestamptz,
  is_synthetic boolean not null default false,
  synthetic_batch text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint users_email_format check (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint users_email_len check (char_length(email) <= 320),
  constraint users_status check (status in ('active', 'disabled')),
  constraint users_password_hash_kind check (password_hash ~ '^(scrypt|argon2id)\$'),
  constraint users_synthetic_labelled check (not is_synthetic or synthetic_batch is not null)
);

-- case-insensitive uniqueness: sign-in must not depend on how the owner typed their email
create unique index users_email_lower_key on public.users (lower(email));

create trigger users_set_updated_at
  before update on public.users
  for each row execute function app.set_updated_at();

comment on column public.users.password_hash is 'scrypt KDF string. Never plaintext, never a fast hash, never returned to the browser.';
comment on column public.users.is_synthetic is 'TRUE for the documented demo accounts; a real customer is FALSE.';

-- ---------------------------------------------------------------------------
-- Server-side sessions
-- ---------------------------------------------------------------------------
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  -- sha256 of the opaque cookie token; the token itself is never stored
  token_hash text not null,
  -- the business the session is currently "in"; re-verified against business_members on
  -- every request, and switched only through app.auth_switch_business()
  active_business_id uuid references public.businesses (id) on delete set null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  -- coarse, hashed request metadata for the audit trail (no raw IPs, no full user agents)
  ip_hash text,
  user_agent_family text,

  constraint sessions_token_hash_key unique (token_hash),
  constraint sessions_token_hash_len check (char_length(token_hash) = 64),
  constraint sessions_expiry_after_creation check (expires_at > created_at)
);

create index sessions_user_id_idx on public.sessions (user_id);
create index sessions_expires_at_idx on public.sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Business profile fields the owner edits in the dashboard
-- ---------------------------------------------------------------------------
alter table public.businesses
  add column if not exists public_welcome_message text,
  add column if not exists hours_summary text;

alter table public.businesses
  add constraint businesses_welcome_message_len check (
    public_welcome_message is null or char_length(public_welcome_message) between 1 and 600
  ),
  add constraint businesses_hours_summary_len check (
    hours_summary is null or char_length(hours_summary) between 1 and 400
  );

-- ---------------------------------------------------------------------------
-- RLS: users/sessions belong to no tenant, so no tenant policy may grant access.
-- The app role keeps table privileges but every policy is absent -> zero rows.
-- Access is only possible through the SECURITY DEFINER functions below, which are
-- reachable from `authenticated` in the Supabase-hosted variant too.
-- ---------------------------------------------------------------------------
alter table public.users enable row level security;
alter table public.users force row level security;
alter table public.sessions enable row level security;
alter table public.sessions force row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'servicefront_app') then
    execute 'grant select, insert, update, delete on public.users, public.sessions to servicefront_app';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Auth entry points (SECURITY DEFINER, run as the schema owner)
-- ---------------------------------------------------------------------------

-- Sign-in step 1: find the credential row for an email. Returns the KDF string so the server
-- can verify it; the browser never sees this result.
create or replace function app.auth_user_by_email(p_email text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select jsonb_build_object(
    'id', u.id,
    'email', u.email,
    'password_hash', u.password_hash,
    'status', u.status,
    'display_name', u.display_name
  )
  from public.users u
  where lower(u.email) = lower(trim(p_email))
  limit 1
$$;

-- A constant, valid-looking KDF string used to burn the same CPU when an email is unknown, so
-- response time cannot be used to enumerate accounts. (Hash of "not-a-real-password".)
create or replace function app.auth_dummy_password_hash()
returns text
language sql
immutable
as $$ select 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='::text $$;

-- Sign-in step 2: create the session and pick the session's first business from the user's
-- active memberships. Membership is the ONLY source of business ids here.
create or replace function app.auth_create_session(
  p_user_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_ip_hash text default null,
  p_user_agent_family text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_session_id uuid;
  v_business_id uuid;
begin
  select m.business_id into v_business_id
  from public.business_members m
  where m.user_id = p_user_id and m.status = 'active'
  order by (m.role = 'business_owner') desc, m.created_at asc
  limit 1;

  insert into public.sessions (user_id, token_hash, active_business_id, expires_at, ip_hash, user_agent_family)
  values (p_user_id, p_token_hash, v_business_id, p_expires_at, p_ip_hash, p_user_agent_family)
  returning id into v_session_id;

  update public.users set last_signed_in_at = now() where id = p_user_id;

  return jsonb_build_object('session_id', v_session_id, 'business_id', v_business_id);
end
$$;

-- Resolve a cookie token to a live session. Returns NULL when the token is unknown, revoked
-- or expired — the caller must treat NULL as "not signed in".
-- `businesses` lists every business this user may act in, from business_members only.
create or replace function app.auth_session(p_token_hash text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select jsonb_build_object(
    'session_id', s.id,
    'user_id', u.id,
    'email', u.email,
    'display_name', u.display_name,
    'active_business_id', s.active_business_id,
    'expires_at', s.expires_at,
    'businesses', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'business_id', m.business_id,
                 'role', m.role,
                 'name', b.name,
                 'slug', b.slug
               )
               order by b.name
             )
      from public.business_members m
      join public.businesses b on b.id = m.business_id
      where m.user_id = u.id and m.status = 'active'
    ), '[]'::jsonb)
  )
  from public.sessions s
  join public.users u on u.id = s.user_id
  where s.token_hash = p_token_hash
    and s.revoked_at is null
    and s.expires_at > now()
    and u.status = 'active'
  limit 1
$$;

-- Membership check used by the app on every request (RLS is the backstop, not the only defence).
create or replace function app.auth_membership_role(p_user_id uuid, p_business_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select m.role::text
  from public.business_members m
  where m.user_id = p_user_id and m.business_id = p_business_id and m.status = 'active'
  limit 1
$$;

-- Switch the active business — only if the user is an active member of the target business.
-- `p_business_id` always comes from a server-verified membership lookup before this is called.
create or replace function app.auth_switch_business(p_token_hash text, p_business_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_user_id uuid;
  v_ok boolean;
begin
  select s.user_id into v_user_id
  from public.sessions s
  join public.users u on u.id = s.user_id
  where s.token_hash = p_token_hash
    and s.revoked_at is null
    and s.expires_at > now()
    and u.status = 'active'
  limit 1;

  if v_user_id is null then
    return false;
  end if;

  select exists (
    select 1 from public.business_members m
    where m.user_id = v_user_id and m.business_id = p_business_id and m.status = 'active'
  ) into v_ok;

  if not v_ok then
    return false;
  end if;

  update public.sessions
     set active_business_id = p_business_id, last_seen_at = now()
   where token_hash = p_token_hash;

  return true;
end
$$;

-- Sign-out: revoke this session. Also revokes every expired session for the same user.
create or replace function app.auth_revoke_session(p_token_hash text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_count integer;
  v_user_id uuid;
begin
  update public.sessions
     set revoked_at = now()
   where token_hash = p_token_hash
     and revoked_at is null
  returning user_id into v_user_id;
  get diagnostics v_count = row_count;

  if v_user_id is not null then
    update public.sessions
       set revoked_at = now()
     where user_id = v_user_id
       and revoked_at is null
       and expires_at <= now();
  end if;

  return v_count > 0;
end
$$;

create or replace function app.auth_touch_session(p_token_hash text)
returns void
language sql
security definer
set search_path = public, pg_catalog
as $$
  update public.sessions set last_seen_at = now() where token_hash = p_token_hash and revoked_at is null
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'servicefront_app') then
    execute 'grant execute on function app.auth_user_by_email(text) to servicefront_app';
    execute 'grant execute on function app.auth_create_session(uuid, text, timestamptz, text, text) to servicefront_app';
    execute 'grant execute on function app.auth_session(text) to servicefront_app';
    execute 'grant execute on function app.auth_membership_role(uuid, uuid) to servicefront_app';
    execute 'grant execute on function app.auth_switch_business(text, uuid) to servicefront_app';
    execute 'grant execute on function app.auth_revoke_session(text) to servicefront_app';
    execute 'grant execute on function app.auth_touch_session(text) to servicefront_app';
    execute 'grant execute on function app.auth_dummy_password_hash() to servicefront_app';
  end if;
end $$;

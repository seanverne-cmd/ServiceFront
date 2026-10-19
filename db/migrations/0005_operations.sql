-- 0005_operations.sql
-- ServiceFront foundation migration 5 of 7: notifications, usage/cost tracking and audit.
--
-- usage_events exists before any billing does, on purpose: cost per conversation has to be
-- measurable from the first real conversation, not reconstructed later.

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  channel notification_channel not null default 'email',
  status notification_status not null default 'pending',
  recipient_user_id uuid,
  recipient_email text,
  subject text not null,
  body text,
  related_lead_id uuid,
  related_conversation_id uuid,
  attempt_count integer not null default 0,
  sent_at timestamptz,
  failed_reason text,
  is_synthetic boolean not null default false,
  synthetic_batch text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint notifications_lead_business_fk
    foreign key (related_lead_id, business_id)
    references public.leads (id, business_id) on delete cascade,
  constraint notifications_conversation_business_fk
    foreign key (related_conversation_id, business_id)
    references public.conversations (id, business_id) on delete cascade,
  constraint notifications_subject_len check (char_length(subject) between 1 and 300),
  constraint notifications_attempts check (attempt_count >= 0),
  constraint notifications_recipient check (recipient_user_id is not null or recipient_email is not null),
  constraint notifications_sent_state check (
    (status = 'sent' and sent_at is not null) or status <> 'sent'
  ),
  constraint notifications_synthetic_labelled check (not is_synthetic or synthetic_batch is not null)
);

create index notifications_business_id_idx on public.notifications (business_id);
create index notifications_business_status_idx on public.notifications (business_id, status);

create trigger notifications_set_updated_at
  before update on public.notifications
  for each row execute function app.set_updated_at();

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  event_type usage_event_type not null,
  quantity numeric(12, 4) not null default 1,
  unit text not null default 'count',
  -- integer micro-units of currency: no floating point money, no rounding surprises
  unit_cost_micros bigint,
  total_cost_micros bigint,
  currency char(3) not null default 'USD',
  conversation_id uuid,
  idempotency_key text,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  is_synthetic boolean not null default false,
  synthetic_batch text,
  created_at timestamptz not null default now(),

  constraint usage_events_conversation_business_fk
    foreign key (conversation_id, business_id)
    references public.conversations (id, business_id) on delete set null,
  constraint usage_events_quantity check (quantity >= 0),
  constraint usage_events_costs check (
    (unit_cost_micros is null or unit_cost_micros >= 0)
    and (total_cost_micros is null or total_cost_micros >= 0)
  ),
  constraint usage_events_synthetic_labelled check (not is_synthetic or synthetic_batch is not null)
);

create index usage_events_business_id_idx on public.usage_events (business_id);
create index usage_events_business_type_time_idx on public.usage_events (business_id, event_type, occurred_at desc);
-- retrying a write must not double-count usage
create unique index usage_events_idempotency_key
  on public.usage_events (business_id, idempotency_key)
  where idempotency_key is not null;

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  actor_user_id uuid,
  actor_role member_role,
  action audit_action not null,
  target_type text,
  target_id uuid,
  -- support_access.* entries are how an admin looking at a tenant's data is provable afterwards
  metadata jsonb not null default '{}'::jsonb,
  actor_ip_hash text,
  user_agent_family text,
  is_synthetic boolean not null default false,
  synthetic_batch text,
  created_at timestamptz not null default now(),

  constraint audit_logs_target_type_len check (target_type is null or char_length(target_type) <= 64),
  constraint audit_logs_synthetic_labelled check (not is_synthetic or synthetic_batch is not null)
);

create index audit_logs_business_id_idx on public.audit_logs (business_id);
create index audit_logs_business_time_idx on public.audit_logs (business_id, created_at desc);
create index audit_logs_action_idx on public.audit_logs (action);

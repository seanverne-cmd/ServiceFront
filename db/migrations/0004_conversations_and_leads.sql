-- 0004_conversations_and_leads.sql
-- ServiceFront foundation migration 4 of 7: widget conversations and the lead pipeline.
--
-- Conversations and messages are the rows an owner will actually read, so they are the
-- most sensitive tenant data in the system. Note the composite foreign keys
-- ((conversation_id, business_id) -> conversations(id, business_id)): even a buggy
-- application query cannot attach a message to another tenant's conversation, because
-- the database itself refuses the mismatched pair.

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  -- opaque, non-identifying ids used by the embeddable widget
  public_id text not null default md5(gen_random_uuid()::text || clock_timestamp()::text),
  visitor_id text,
  visitor_token_hash text,
  channel text not null default 'widget',
  status conversation_status not null default 'open',
  page_url text,
  referrer text,
  user_agent_family text,
  -- PII minimisation: we store a salted hash, never a raw IP address
  visitor_ip_hash text,
  started_at timestamptz not null default now(),
  last_message_at timestamptz,
  ended_at timestamptz,
  retention_expires_at timestamptz,
  message_count integer not null default 0,
  is_synthetic boolean not null default false,
  synthetic_batch text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint conversations_public_id_key unique (public_id),
  constraint conversations_id_business_key unique (id, business_id),
  constraint conversations_channel check (channel in ('widget', 'phone', 'email', 'sms')),
  constraint conversations_message_count check (message_count >= 0),
  constraint conversations_time_order check (
    (last_message_at is null or last_message_at >= started_at)
    and (ended_at is null or ended_at >= started_at)
  ),
  constraint conversations_visitor_id_format check (visitor_id is null or visitor_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  constraint conversations_synthetic_labelled check (not is_synthetic or synthetic_batch is not null)
);

create index conversations_business_id_idx on public.conversations (business_id);
create index conversations_business_started_idx on public.conversations (business_id, started_at desc);
create index conversations_business_status_idx on public.conversations (business_id, status);

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function app.set_updated_at();

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  conversation_id uuid not null,
  role message_role not null,
  source message_source not null,
  content text not null,
  content_sha256 text,
  -- traceability of an answer back to the business's own approved facts
  answered_from_knowledge boolean,
  cited_fact_refs jsonb not null default '[]'::jsonb,
  confidence numeric(4, 3),
  model_provider text,
  model_name text,
  tokens_prompt integer,
  tokens_completion integer,
  latency_ms integer,
  is_synthetic boolean not null default false,
  synthetic_batch text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint messages_conversation_business_fk
    foreign key (conversation_id, business_id)
    references public.conversations (id, business_id) on delete cascade,
  constraint messages_content_len check (char_length(content) between 1 and 8000),
  constraint messages_confidence_range check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint messages_tokens_non_negative check (
    (tokens_prompt is null or tokens_prompt >= 0) and (tokens_completion is null or tokens_completion >= 0)
  ),
  constraint messages_latency_non_negative check (latency_ms is null or latency_ms >= 0),
  -- a live-model answer must name its model; a demo answer must not pretend to be live
  constraint messages_live_requires_model check (
    source <> 'assistant_live' or model_name is not null
  ),
  constraint messages_synthetic_labelled check (not is_synthetic or synthetic_batch is not null)
);

create index messages_business_id_idx on public.messages (business_id);
create index messages_conversation_idx on public.messages (business_id, conversation_id, created_at);

create trigger messages_set_updated_at
  before update on public.messages
  for each row execute function app.set_updated_at();

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  conversation_id uuid,
  category lead_category not null default 'general_enquiry',
  status lead_status not null default 'new',
  full_name text,
  email text,
  phone text,
  postal_code text,
  service_interest text,
  message_excerpt text,
  source text not null default 'widget',
  is_after_hours boolean not null default false,
  consent_to_contact boolean not null default false,
  owner_user_id uuid,
  first_responded_at timestamptz,
  closed_at timestamptz,
  is_synthetic boolean not null default false,
  synthetic_batch text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint leads_id_business_key unique (id, business_id),
  constraint leads_conversation_business_fk
    foreign key (conversation_id, business_id)
    references public.conversations (id, business_id) on delete set null,
  constraint leads_source check (source in ('widget', 'phone', 'email', 'sms', 'referral', 'import')),
  -- a lead we cannot contact is not a lead
  constraint leads_contactable check (email is not null or phone is not null),
  constraint leads_email_format check (
    email is null or email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  constraint leads_phone_format check (phone is null or phone ~ '^[0-9+()\-.\s]{7,32}$'),
  constraint leads_excerpt_len check (message_excerpt is null or char_length(message_excerpt) <= 2000),
  constraint leads_consent_when_contactable check (
    (email is null and phone is null) or consent_to_contact
  ),
  constraint leads_synthetic_labelled check (not is_synthetic or synthetic_batch is not null)
);

create index leads_business_id_idx on public.leads (business_id);
create index leads_business_status_idx on public.leads (business_id, status);
create index leads_business_created_idx on public.leads (business_id, created_at desc);
create index leads_conversation_idx on public.leads (conversation_id);

create trigger leads_set_updated_at
  before update on public.leads
  for each row execute function app.set_updated_at();

-- Append-only pipeline history: who moved a lead, from what, to what, when.
create table public.lead_status_history (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  lead_id uuid not null,
  from_status lead_status,
  to_status lead_status not null,
  changed_by_user_id uuid,
  note text,
  is_synthetic boolean not null default false,
  synthetic_batch text,
  created_at timestamptz not null default now(),

  constraint lead_status_history_lead_business_fk
    foreign key (lead_id, business_id)
    references public.leads (id, business_id) on delete cascade,
  constraint lead_status_history_transition check (from_status is distinct from to_status),
  constraint lead_status_history_note_len check (note is null or char_length(note) <= 1000),
  constraint lead_status_history_synthetic_labelled check (not is_synthetic or synthetic_batch is not null)
);

create index lead_status_history_business_id_idx on public.lead_status_history (business_id);
create index lead_status_history_lead_idx on public.lead_status_history (business_id, lead_id, created_at);

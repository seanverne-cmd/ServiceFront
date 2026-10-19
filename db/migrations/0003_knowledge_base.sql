-- 0003_knowledge_base.sql
-- ServiceFront foundation migration 3 of 7: the approved facts an AI receptionist may
-- answer from. Everything the widget says must trace back to a row in these tables
-- (or to businesses / business_hours), which is what keeps answers non-invented.

create table public.services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  slug text not null,
  name text not null,
  description text,
  category text,
  is_emergency boolean not null default false,
  is_active boolean not null default true,
  price_note text,
  sort_order integer not null default 0,
  is_synthetic boolean not null default false,
  synthetic_batch text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint services_business_slug_key unique (business_id, slug),
  constraint services_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint services_name_len check (char_length(name) between 2 and 160),
  constraint services_synthetic_labelled check (not is_synthetic or synthetic_batch is not null)
);

create index services_business_id_idx on public.services (business_id);
create index services_business_active_idx on public.services (business_id, is_active);

create trigger services_set_updated_at
  before update on public.services
  for each row execute function app.set_updated_at();

create table public.service_areas (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null,
  city text,
  region text,
  postal_code text,
  country_code char(2) not null default 'US',
  is_primary boolean not null default false,
  travel_note text,
  is_active boolean not null default true,
  is_synthetic boolean not null default false,
  synthetic_batch text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint service_areas_business_name_key unique (business_id, name),
  constraint service_areas_name_len check (char_length(name) between 2 and 120),
  constraint service_areas_synthetic_labelled check (not is_synthetic or synthetic_batch is not null)
);

create index service_areas_business_id_idx on public.service_areas (business_id);
-- answering "do you service Fullerton?" is a lookup on (business_id, city)
create index service_areas_business_city_idx on public.service_areas (business_id, lower(city));

create trigger service_areas_set_updated_at
  before update on public.service_areas
  for each row execute function app.set_updated_at();

create table public.faqs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  question text not null,
  answer text not null,
  category text,
  tags text[] not null default '{}',
  is_published boolean not null default true,
  sort_order integer not null default 0,
  is_synthetic boolean not null default false,
  synthetic_batch text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint faqs_business_question_key unique (business_id, question),
  constraint faqs_question_len check (char_length(question) between 4 and 300),
  constraint faqs_answer_len check (char_length(answer) between 4 and 4000),
  constraint faqs_synthetic_labelled check (not is_synthetic or synthetic_batch is not null)
);

create index faqs_business_id_idx on public.faqs (business_id);
create index faqs_business_published_idx on public.faqs (business_id, is_published);

create trigger faqs_set_updated_at
  before update on public.faqs
  for each row execute function app.set_updated_at();

-- Opening hours are stored as one row per opening window, in the business's local time.
create table public.business_hours (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  day_of_week smallint not null,          -- 0 = Sunday .. 6 = Saturday (matches JS getDay())
  opens_at time,
  closes_at time,
  is_closed boolean not null default false,
  appointment_only boolean not null default false,
  timezone text not null default 'America/Los_Angeles',
  note text,
  is_synthetic boolean not null default false,
  synthetic_batch text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint business_hours_day_range check (day_of_week between 0 and 6),
  -- a window is either fully closed, or open with a sane start before end
  constraint business_hours_window check (
    (is_closed and opens_at is null and closes_at is null)
    or (not is_closed and opens_at is not null and closes_at is not null and opens_at < closes_at)
  ),
  constraint business_hours_business_day_opens_key unique (business_id, day_of_week, opens_at),
  constraint business_hours_synthetic_labelled check (not is_synthetic or synthetic_batch is not null)
);

create index business_hours_business_id_idx on public.business_hours (business_id);

create trigger business_hours_set_updated_at
  before update on public.business_hours
  for each row execute function app.set_updated_at();

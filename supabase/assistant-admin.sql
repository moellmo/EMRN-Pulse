create table if not exists public.assistant_config (
  id text primary key,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.assistant_analytics (
  id uuid primary key default gen_random_uuid(),
  event_type text,
  session_id text,
  language text,
  query text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists assistant_analytics_created_at_idx on public.assistant_analytics (created_at desc);
create index if not exists assistant_analytics_event_type_idx on public.assistant_analytics (event_type);
create index if not exists assistant_analytics_query_idx on public.assistant_analytics (query);

create table if not exists public.assistant_quotes (
  id uuid primary key default gen_random_uuid(),
  email text,
  name text,
  language text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists assistant_quotes_created_at_idx on public.assistant_quotes (created_at desc);

create table if not exists public.assistant_support (
  id uuid primary key default gen_random_uuid(),
  email text,
  category text,
  language text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists assistant_support_created_at_idx on public.assistant_support (created_at desc);

create table if not exists public.assistant_ai_usage (
  id uuid primary key default gen_random_uuid(),
  feature text,
  model text,
  session_id text,
  language text,
  query text,
  estimated_cost_usd numeric,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists assistant_ai_usage_created_at_idx on public.assistant_ai_usage (created_at desc);

create table if not exists public.assistant_knowledge_memory (
  id text primary key,
  type text not null,
  query text not null default '',
  status text not null default 'needs_review',
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists assistant_knowledge_memory_status_idx on public.assistant_knowledge_memory (status);
create index if not exists assistant_knowledge_memory_updated_at_idx on public.assistant_knowledge_memory (updated_at desc);

create table if not exists public.assistant_answer_cache (
  key text primary key,
  language text,
  query text,
  answer_path text,
  hit_count integer not null default 0,
  payload jsonb not null,
  expires_at timestamptz not null,
  last_hit_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists assistant_answer_cache_expires_at_idx on public.assistant_answer_cache (expires_at);
create index if not exists assistant_answer_cache_last_hit_at_idx on public.assistant_answer_cache (last_hit_at desc);
create index if not exists assistant_answer_cache_query_idx on public.assistant_answer_cache (query);

alter table public.assistant_config enable row level security;
alter table public.assistant_analytics enable row level security;
alter table public.assistant_quotes enable row level security;
alter table public.assistant_support enable row level security;
alter table public.assistant_ai_usage enable row level security;
alter table public.assistant_knowledge_memory enable row level security;
alter table public.assistant_answer_cache enable row level security;

-- Use EMRN_SUPABASE_SERVICE_ROLE_KEY on the server. The service role bypasses RLS.
-- Do not create public anon policies for these admin tables unless you are deliberately building a separate locked-down client flow.

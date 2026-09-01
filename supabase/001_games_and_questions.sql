-- Step 1: Host Game Builder schema
-- Run this in the Supabase SQL editor (Project -> SQL Editor -> New query).

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'Untitled Game',
  created_at timestamptz not null default now()
);

create table if not exists questions (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete cascade,
  type text not null default 'text' check (type in ('text', 'image', 'audio', 'video')),
  prompt text not null default '',
  media_url text,
  points integer not null default 100,
  time_limit integer not null default 30,
  order_index integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists questions_game_id_idx on questions(game_id);

-- RLS: permissive for now since there's no host auth yet.
-- Tighten this once auth/ownership is added in a later step.
alter table games enable row level security;
alter table questions enable row level security;

drop policy if exists "public can manage games" on games;
create policy "public can manage games" on games
  for all using (true) with check (true);

drop policy if exists "public can manage questions" on questions;
create policy "public can manage questions" on questions
  for all using (true) with check (true);

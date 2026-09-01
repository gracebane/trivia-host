-- Step 1 revision: PowerPoint import + answer key
-- Run this in the Supabase SQL editor after 001_games_and_questions.sql.

alter table questions add column if not exists answers text[] not null default '{}';

-- Storage bucket for media (audio/image/video) extracted from imported .pptx files.
insert into storage.buckets (id, name, public)
values ('question-media', 'question-media', true)
on conflict (id) do nothing;

-- Permissive for now since there's no host auth yet.
-- Tighten these once auth/ownership is added in a later step.
drop policy if exists "public can read question media" on storage.objects;
create policy "public can read question media" on storage.objects
  for select using (bucket_id = 'question-media');

drop policy if exists "public can upload question media" on storage.objects;
create policy "public can upload question media" on storage.objects
  for insert with check (bucket_id = 'question-media');

drop policy if exists "public can update question media" on storage.objects;
create policy "public can update question media" on storage.objects
  for update using (bucket_id = 'question-media');

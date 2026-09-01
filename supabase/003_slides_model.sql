-- Step 1 revision: slides are question / non-question, plus a thumbnail for host tracking.
-- Run this in the Supabase SQL editor after 001 and 002.

alter table questions add column if not exists is_question boolean not null default true;
alter table questions add column if not exists thumbnail_url text;

-- Step 2: Live hosting — sessions, teams, players, answers.
-- Run this in the Supabase SQL editor after 001-003.

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete cascade,
  join_code text not null unique,
  status text not null default 'lobby' check (status in ('lobby', 'active', 'ended')),
  current_slide_index integer,
  answers_open boolean not null default false,
  current_slide_started_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  name text not null,
  captain_player_id uuid,
  score integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

alter table teams drop constraint if exists teams_captain_fk;
alter table teams add constraint teams_captain_fk foreign key (captain_player_id) references players(id) on delete set null;

create table if not exists answers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  question_id uuid not null references questions(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  submitted_text text not null,
  is_correct boolean,
  created_at timestamptz not null default now(),
  unique (session_id, question_id, team_id)
);

create index if not exists teams_session_id_idx on teams(session_id);
create index if not exists players_session_id_idx on players(session_id);
create index if not exists players_team_id_idx on players(team_id);
create index if not exists answers_session_id_idx on answers(session_id);
create index if not exists answers_question_id_idx on answers(question_id);

alter table sessions enable row level security;
alter table teams enable row level security;
alter table players enable row level security;
alter table answers enable row level security;

-- Permissive for now, no auth yet. Tighten once host/player accounts exist.
drop policy if exists "public can manage sessions" on sessions;
create policy "public can manage sessions" on sessions for all using (true) with check (true);

drop policy if exists "public can manage teams" on teams;
create policy "public can manage teams" on teams for all using (true) with check (true);

drop policy if exists "public can manage players" on players;
create policy "public can manage players" on players for all using (true) with check (true);

-- Answers are read/managed by the host UI; inserts/updates from players go
-- through submit_team_answer() below so the answer key never reaches them.
drop policy if exists "public can manage answers" on answers;
create policy "public can manage answers" on answers for all using (true) with check (true);

-- Realtime
alter publication supabase_realtime add table sessions;
alter publication supabase_realtime add table teams;
alter publication supabase_realtime add table players;
alter publication supabase_realtime add table answers;

-- Server-side grading so the acceptable-answers list never has to be sent
-- to a player's browser to grade their own submission.
create extension if not exists fuzzystrmatch;

drop function if exists submit_team_answer(uuid, uuid, uuid, text);

create or replace function submit_team_answer(
  p_session_id uuid,
  p_question_id uuid,
  p_team_id uuid,
  p_submitted_text text
) returns table (answer_id uuid, is_correct_result boolean) as $$
declare
  v_session sessions%rowtype;
  v_question questions%rowtype;
  v_accepted text;
  v_matched boolean := false;
  v_norm_submitted text := lower(trim(p_submitted_text));
  v_norm_accepted text;
  v_max_len int;
  v_distance int;
begin
  select * into v_session from sessions where id = p_session_id;
  if not found or v_session.status <> 'active' or v_session.answers_open is not true then
    raise exception 'Answers are not open for this session.';
  end if;

  select * into v_question from questions where id = p_question_id and game_id = v_session.game_id;
  if not found then
    raise exception 'Question not found for this session.';
  end if;

  foreach v_accepted in array coalesce(v_question.answers, array[]::text[])
  loop
    v_norm_accepted := lower(trim(v_accepted));
    v_max_len := greatest(length(v_norm_submitted), length(v_norm_accepted));
    if v_max_len = 0 then
      continue;
    end if;
    if v_norm_submitted = v_norm_accepted then
      v_matched := true;
      exit;
    end if;
    v_distance := levenshtein(v_norm_submitted, v_norm_accepted);
    if v_distance::float / v_max_len <= 0.2 then
      v_matched := true;
      exit;
    end if;
  end loop;

  return query
    insert into answers (session_id, question_id, team_id, submitted_text, is_correct)
    values (p_session_id, p_question_id, p_team_id, p_submitted_text, case when v_matched then true else null end)
    on conflict (session_id, question_id, team_id)
    do update set submitted_text = excluded.submitted_text,
                  is_correct = case when v_matched then true else null end
    returning answers.id, answers.is_correct;
end;
$$ language plpgsql security definer;

create or replace function adjust_team_score(p_team_id uuid, p_delta integer)
returns void as $$
  update teams set score = score + p_delta where id = p_team_id;
$$ language sql;

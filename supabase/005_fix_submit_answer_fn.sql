-- Fixes an "ambiguous column" bug in submit_team_answer: its OUT parameters
-- were named id/is_correct, colliding with the answers table's own columns.
-- Run this after 004_live_sessions.sql.

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

-- Fixes a scoring bug: points were only ever awarded from the host's
-- "Mark Correct" click, so answers auto-matched by submit_team_answer()
-- (correct on submission, is_correct set straight to true) never scored,
-- since the button for an already-true answer is disabled.
--
-- Moves scoring into a trigger so ANY change to answers.is_correct —
-- whether from the RPC's auto-match or the host's manual review — awards
-- or revokes points exactly once. adjust_team_score() is no longer needed.

drop function if exists adjust_team_score(uuid, integer);

create or replace function apply_answer_score() returns trigger as $$
declare
  v_points integer;
  v_was_correct boolean;
  v_is_correct boolean;
begin
  select points into v_points from questions where id = new.question_id;

  if TG_OP = 'INSERT' then
    v_was_correct := false;
  else
    v_was_correct := coalesce(old.is_correct, false);
  end if;

  v_is_correct := coalesce(new.is_correct, false);

  if v_was_correct <> v_is_correct then
    update teams
    set score = score + (case when v_is_correct then v_points else -v_points end)
    where id = new.team_id;
  end if;

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists answers_score_trigger on answers;
create trigger answers_score_trigger
after insert or update of is_correct on answers
for each row
execute function apply_answer_score();

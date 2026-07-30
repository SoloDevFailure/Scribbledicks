-- Keeps future opening prompts neutral so player answers, rather than the game,
-- determine whether the story becomes serious, comic, strange, or mundane.
create or replace function public.set_neutral_opening_prompt()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.prompt_text := case new.role_key
    when 'CHARACTER' then 'Who is the main character in this story? It can be a person, fictional character, animal, object, or anything else.'
    when 'SETTING' then 'Where does this story begin? Choose any real or fictional location.'
    when 'INCITING_EVENT' then 'What unexpected event happens that sets the story in motion?'
    when 'ANTAGONIST' then 'Who or what causes the main problem?'
    when 'GOAL' then 'What is someone trying to achieve?'
    when 'OBSTACLE' then 'What makes the situation harder?'
    when 'OBJECT' then 'What object becomes important to the story?'
    when 'TIME' then 'When does this story take place? It may be a time period, date, season, or particular moment.'
    when 'CONSEQUENCE' then 'What will happen if the problem is not solved?'
    when 'HELPER' then 'Who or what helps during the story?'
    when 'SECRET' then 'What secret is somebody hiding?'
    when 'TRANSPORT' then 'How does someone travel during the story?'
    when 'TWIST' then 'What unexpected complication occurs?'
    when 'RULE' then 'What rule must everyone obey?'
    when 'REWARD' then 'What does someone hope to gain if they succeed?'
    else 'Name one detail that could become important during the story.'
  end;
  return new;
end;
$$;

drop trigger if exists set_neutral_opening_prompt on public.prompt_assignments;
create trigger set_neutral_opening_prompt
before insert on public.prompt_assignments
for each row execute function public.set_neutral_opening_prompt();

revoke all on function public.set_neutral_opening_prompt() from public;

-- Keep the stored AI request metadata aligned with the neutral, player-led
-- treatment used by the Edge Function.
create or replace function public.claim_outline_job(p_game_id uuid, p_player_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare payload jsonb;
begin
  if not exists (
    select 1 from public.game_participants gp join public.players p on p.id = gp.player_id
    where gp.game_session_id = p_game_id and p.client_token = p_player_token
  ) then raise exception 'NOT_PARTICIPANT'; end if;
  update public.ai_jobs
  set status = 'running', attempt_count = attempt_count + 1, started_at = now(), error_message = null
  where game_session_id = p_game_id and status in ('pending', 'failed') and attempt_count < 3;
  if not found then return null; end if;
  select jsonb_build_object(
    'gameId', gs.id, 'playerCount', gs.player_count, 'tone', 'player-led and sincere',
    'ingredients', coalesce(jsonb_agg(jsonb_build_object(
      'role', pa.role_key, 'answer', ans.answer_text
    ) order by pa.role_key) filter (where ans.id is not null), '[]'::jsonb)
  ) into payload
  from public.game_sessions gs
  left join public.prompt_assignments pa on pa.game_session_id = gs.id
  left join public.prompt_answers ans on ans.assignment_id = pa.id
  where gs.id = p_game_id and gs.phase = 'composing_outline'
  group by gs.id;
  update public.ai_jobs set request_payload = payload where game_session_id = p_game_id;
  return payload;
end;
$$;

revoke all on function public.claim_outline_job(uuid, uuid) from public;
grant execute on function public.claim_outline_job(uuid, uuid) to service_role;

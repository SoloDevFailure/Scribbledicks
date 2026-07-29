-- Round two and final preview: private follow-up questions, a second shared
-- deadline, and a structured <=90-second story split into one panel per player.

alter table public.rooms drop constraint if exists rooms_game_phase_check;
update public.rooms set game_phase = 'error' where game_phase = 'opening_complete';
alter table public.rooms add constraint rooms_game_phase_check check (
  game_phase in (
    'lobby','opening_questions','composing_outline','followup_questions',
    'composing_story','story_complete','error'
  )
);
alter table public.game_sessions drop constraint if exists game_sessions_phase_check;
update public.game_sessions set phase = 'error' where phase = 'opening_complete';
alter table public.game_sessions add constraint game_sessions_phase_check check (
  phase in (
    'lobby','opening_questions','composing_outline','followup_questions',
    'composing_story','story_complete','error'
  )
);
alter table public.prompt_assignments drop constraint if exists prompt_assignments_phase_check;
alter table public.prompt_assignments add constraint prompt_assignments_phase_check check (
  phase in ('opening_questions','followup_questions')
);
alter table public.ai_jobs drop constraint if exists ai_jobs_job_type_check;
alter table public.ai_jobs add constraint ai_jobs_job_type_check check (
  job_type in ('compose_outline','compose_story')
);

create table public.final_stories (
  id uuid primary key default gen_random_uuid(),
  game_session_id uuid not null unique references public.game_sessions(id) on delete cascade,
  structured_story jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.final_stories enable row level security;
revoke all on public.final_stories from anon, authenticated;

create or replace function public.set_neutral_opening_prompt()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.phase <> 'opening_questions' then return new; end if;
  new.prompt_text := case new.role_key
    when 'CHARACTER' then 'Who is the main character in this story? It can be a person, fictional character, animal, object, or anything else.'
    when 'SETTING' then 'Where does this story begin? Choose any real or fictional location.'
    when 'INCITING_EVENT' then 'What unexpected event happens that sets the story in motion?'
    when 'ANTAGONIST' then 'Who or what causes the main problem?'
    when 'GOAL' then 'What is someone trying to achieve?'
    when 'OBSTACLE' then 'What makes the situation harder?'
    when 'OBJECT' then 'What object becomes important to the story?'
    when 'TIME' then 'When does this story take place?'
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

create or replace function public.complete_outline_job(
  p_game_id uuid, p_outline jsonb, p_model text, p_usage jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare
  target_room uuid;
  expected_count integer;
begin
  select player_count, room_id into expected_count, target_room
  from public.game_sessions where id = p_game_id and phase = 'composing_outline';
  if target_room is null then raise exception 'GAME_NOT_COMPOSING_OUTLINE'; end if;
  if jsonb_array_length(p_outline->'unresolvedSlots') <> expected_count then
    raise exception 'INVALID_FOLLOWUP_COUNT';
  end if;

  insert into public.story_outlines(game_session_id, structured_outline)
  values (p_game_id, p_outline)
  on conflict (game_session_id) do update
    set structured_outline = excluded.structured_outline, updated_at = now();

  insert into public.prompt_assignments(
    game_session_id, participant_id, phase, role_key, prompt_text
  )
  select p_game_id, participants.id, 'followup_questions',
    slots.value->>'slotKey', slots.value->>'genericQuestion'
  from (
    select gp.id, row_number() over (order by gen_random_uuid()) as position
    from public.game_participants gp
    where gp.game_session_id = p_game_id and gp.active
  ) participants
  join lateral jsonb_array_elements(p_outline->'unresolvedSlots')
    with ordinality slots(value, position)
    on slots.position = participants.position
  on conflict (game_session_id, participant_id, phase) do nothing;

  update public.ai_jobs set status = 'completed', response_payload = p_outline,
    model_name = p_model, token_usage = p_usage, completed_at = now()
  where game_session_id = p_game_id and job_type = 'compose_outline';
  update public.game_sessions set phase = 'followup_questions',
    phase_started_at = now(), phase_deadline_at = now() + interval '60 seconds',
    updated_at = now()
  where id = p_game_id;
  update public.rooms set game_phase = 'followup_questions', answer_count = 0
  where id = target_room;
end;
$$;

create or replace function public.advance_followup_phase_internal(p_game_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare target_room uuid;
begin
  update public.game_sessions gs
  set phase = 'composing_story', phase_started_at = now(),
      phase_deadline_at = null, updated_at = now()
  where gs.id = p_game_id and gs.phase = 'followup_questions'
    and (
      gs.phase_deadline_at <= now()
      or (select count(*) from public.prompt_assignments pa
          where pa.game_session_id = gs.id and pa.phase = 'followup_questions'
            and pa.submitted_at is not null) >= gs.player_count
    )
  returning gs.room_id into target_room;
  if target_room is null then return false; end if;
  insert into public.ai_jobs(game_session_id, job_type)
  values (p_game_id, 'compose_story')
  on conflict (game_session_id, job_type) do nothing;
  update public.rooms set game_phase = 'composing_story' where id = target_room;
  return true;
end;
$$;

create or replace function public.get_game_state(p_room_id uuid, p_player_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  select jsonb_build_object(
    'gameId', gs.id, 'phase', gs.phase,
    'phaseStartedAt', gs.phase_started_at, 'phaseDeadlineAt', gs.phase_deadline_at,
    'playerCount', gs.player_count,
    'answerCount', case
      when gs.phase in ('opening_questions','followup_questions') then
        (select count(*) from public.prompt_assignments x
         where x.game_session_id = gs.id and x.phase = gs.phase and x.submitted_at is not null)
      else 0 end,
    'isHost', p.is_host,
    'assignmentId', pa.id, 'promptText', pa.prompt_text,
    'submittedAt', pa.submitted_at, 'answerText', ans.answer_text,
    'aiJobStatus', job.status,
    'aiJobType', job.job_type,
    'aiError', case when p.is_host then job.error_message else null end,
    'aiAttemptCount', coalesce(job.attempt_count, 0),
    'story', story.structured_story
  ) into result
  from public.players p
  join public.game_participants gp on gp.player_id = p.id and gp.active
  join public.game_sessions gs on gs.id = gp.game_session_id and gs.status in ('active','error')
  left join public.prompt_assignments pa on pa.participant_id = gp.id
    and pa.game_session_id = gs.id and pa.phase = gs.phase
  left join public.prompt_answers ans on ans.assignment_id = pa.id
  left join public.ai_jobs job on job.game_session_id = gs.id
    and job.job_type = case
      when gs.phase in ('composing_story','story_complete')
        or exists (select 1 from public.ai_jobs sj
                   where sj.game_session_id = gs.id and sj.job_type = 'compose_story')
        then 'compose_story'
      else 'compose_outline' end
  left join public.final_stories story on story.game_session_id = gs.id
  where p.room_id = p_room_id and p.client_token = p_player_token
  order by gs.created_at desc limit 1;
  if result is null then raise exception 'GAME_NOT_FOUND'; end if;
  return result;
end;
$$;

create or replace function public.submit_followup_answer(
  p_game_id uuid, p_player_token uuid, p_answer_text text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare target_assignment public.prompt_assignments;
declare participant_record public.game_participants;
declare clean_answer text := btrim(p_answer_text);
declare target_room uuid;
begin
  if char_length(clean_answer) not between 1 and 250 then raise exception 'INVALID_ANSWER'; end if;
  select gp.* into participant_record
  from public.game_participants gp join public.players p on p.id = gp.player_id
  where gp.game_session_id = p_game_id and gp.active and p.client_token = p_player_token;
  if not found then raise exception 'NOT_PARTICIPANT'; end if;
  if not exists (
    select 1 from public.game_sessions gs where gs.id = p_game_id
      and gs.phase = 'followup_questions' and gs.phase_deadline_at > now()
  ) then
    perform public.advance_followup_phase_internal(p_game_id);
    raise exception 'SUBMISSIONS_CLOSED';
  end if;
  select pa.* into target_assignment from public.prompt_assignments pa
  where pa.game_session_id = p_game_id and pa.participant_id = participant_record.id
    and pa.phase = 'followup_questions';
  insert into public.prompt_answers(assignment_id, participant_id, answer_text)
  values(target_assignment.id, participant_record.id, clean_answer)
  on conflict (assignment_id) do nothing;
  update public.prompt_assignments set submitted_at = coalesce(submitted_at, now())
  where id = target_assignment.id;
  select room_id into target_room from public.game_sessions where id = p_game_id;
  update public.rooms set answer_count = (
    select count(*) from public.prompt_assignments
    where game_session_id = p_game_id and phase = 'followup_questions'
      and submitted_at is not null
  ) where id = target_room;
  perform public.advance_followup_phase_internal(p_game_id);
  return public.get_game_state(target_room, p_player_token);
end;
$$;

create or replace function public.check_game_progress(p_game_id uuid, p_player_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare current_phase text;
begin
  if not exists (
    select 1 from public.game_participants gp join public.players p on p.id = gp.player_id
    where gp.game_session_id = p_game_id and gp.active and p.client_token = p_player_token
  ) then raise exception 'NOT_PARTICIPANT'; end if;
  select phase into current_phase from public.game_sessions where id = p_game_id;
  if current_phase = 'opening_questions' then
    return public.advance_opening_phase_internal(p_game_id);
  elsif current_phase = 'followup_questions' then
    return public.advance_followup_phase_internal(p_game_id);
  end if;
  return false;
end;
$$;

create or replace function public.claim_story_job(p_game_id uuid, p_player_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare payload jsonb;
begin
  if not exists (
    select 1 from public.game_participants gp join public.players p on p.id = gp.player_id
    where gp.game_session_id = p_game_id and p.client_token = p_player_token
  ) then raise exception 'NOT_PARTICIPANT'; end if;
  update public.ai_jobs set status = 'running', attempt_count = attempt_count + 1,
    started_at = now(), error_message = null
  where game_session_id = p_game_id and job_type = 'compose_story'
    and status in ('pending','failed') and attempt_count < 3;
  if not found then return null; end if;
  select jsonb_build_object(
    'playerCount', gs.player_count,
    'outline', so.structured_outline,
    'contributions', coalesce(jsonb_agg(jsonb_build_object(
      'phase', pa.phase, 'role', pa.role_key, 'answer', ans.answer_text
    ) order by pa.created_at) filter (where ans.id is not null), '[]'::jsonb)
  ) into payload
  from public.game_sessions gs
  join public.story_outlines so on so.game_session_id = gs.id
  left join public.prompt_assignments pa on pa.game_session_id = gs.id
  left join public.prompt_answers ans on ans.assignment_id = pa.id
  where gs.id = p_game_id and gs.phase = 'composing_story'
  group by gs.id, so.structured_outline;
  update public.ai_jobs set request_payload = payload
  where game_session_id = p_game_id and job_type = 'compose_story';
  return payload;
end;
$$;

create or replace function public.complete_story_job(
  p_game_id uuid, p_story jsonb, p_model text, p_usage jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare target_room uuid;
begin
  insert into public.final_stories(game_session_id, structured_story)
  values(p_game_id, p_story)
  on conflict(game_session_id) do update
    set structured_story = excluded.structured_story, updated_at = now();
  update public.ai_jobs set status = 'completed', response_payload = p_story,
    model_name = p_model, token_usage = p_usage, completed_at = now()
  where game_session_id = p_game_id and job_type = 'compose_story';
  update public.game_sessions set phase = 'story_complete', updated_at = now()
  where id = p_game_id returning room_id into target_room;
  update public.rooms set game_phase = 'story_complete' where id = target_room;
end;
$$;

create or replace function public.retry_story_job(p_game_id uuid, p_player_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.game_participants gp join public.players p on p.id = gp.player_id
    where gp.game_session_id = p_game_id and p.client_token = p_player_token and p.is_host
  ) then raise exception 'HOST_ONLY'; end if;
  update public.ai_jobs set status = 'pending', error_message = null,
    started_at = null, completed_at = null
  where game_session_id = p_game_id and job_type = 'compose_story'
    and status = 'failed' and attempt_count < 3;
  update public.game_sessions set phase = 'composing_story', updated_at = now() where id = p_game_id;
  update public.rooms set game_phase = 'composing_story'
  where id = (select room_id from public.game_sessions where id = p_game_id);
end;
$$;

create or replace function public.fail_story_job(p_game_id uuid, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
declare target_room uuid;
begin
  update public.ai_jobs set status = 'failed', error_message = left(p_error, 500),
    completed_at = now()
  where game_session_id = p_game_id and job_type = 'compose_story';
  update public.game_sessions set phase = 'error', updated_at = now()
  where id = p_game_id returning room_id into target_room;
  update public.rooms set game_phase = 'error' where id = target_room;
end;
$$;

revoke all on function public.advance_followup_phase_internal(uuid) from public;
revoke all on function public.submit_followup_answer(uuid,uuid,text) from public;
revoke all on function public.claim_story_job(uuid,uuid) from public;
revoke all on function public.complete_story_job(uuid,jsonb,text,jsonb) from public;
revoke all on function public.retry_story_job(uuid,uuid) from public;
revoke all on function public.fail_story_job(uuid,text) from public;
grant execute on function public.submit_followup_answer(uuid,uuid,text) to anon,authenticated;
grant execute on function public.retry_story_job(uuid,uuid) to anon,authenticated;
grant execute on function public.claim_story_job(uuid,uuid) to service_role;
grant execute on function public.complete_story_job(uuid,jsonb,text,jsonb) to service_role;
grant execute on function public.fail_story_job(uuid,text) to service_role;

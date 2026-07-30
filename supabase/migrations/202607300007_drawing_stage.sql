-- Multiplayer drawing phase. Final-story panels are copied unchanged into
-- private relational records, shuffled onto participants once, and resolved
-- against private Storage objects before the future premiere.

alter table public.rooms drop constraint if exists rooms_game_phase_check;
alter table public.rooms add constraint rooms_game_phase_check check (
  game_phase in (
    'lobby','opening_questions','composing_outline','followup_questions',
    'composing_story','story_complete','drawing','drawing_complete',
    'drawing_error','error'
  )
);

alter table public.game_sessions
  add column if not exists drawing_started_at timestamptz,
  add column if not exists drawing_deadline_at timestamptz;
alter table public.game_sessions drop constraint if exists game_sessions_phase_check;
alter table public.game_sessions add constraint game_sessions_phase_check check (
  phase in (
    'lobby','opening_questions','composing_outline','followup_questions',
    'composing_story','story_complete','drawing','drawing_complete',
    'drawing_error','error'
  )
);

create table public.storyboard_panels (
  id uuid primary key default gen_random_uuid(),
  game_session_id uuid not null references public.game_sessions(id) on delete cascade,
  panel_number integer not null check (panel_number > 0),
  narration text not null,
  dialogue text,
  drawing_brief jsonb not null,
  story_beat text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(game_session_id, panel_number),
  unique(id, game_session_id)
);
create index storyboard_panels_game_order_idx
  on public.storyboard_panels(game_session_id, panel_number);

create table public.drawing_assignments (
  id uuid primary key default gen_random_uuid(),
  game_session_id uuid not null references public.game_sessions(id) on delete cascade,
  participant_id uuid not null references public.game_participants(id) on delete cascade,
  storyboard_panel_id uuid not null,
  status text not null default 'assigned'
    check (status in ('assigned','submitted','blank','missing','failed')),
  assigned_at timestamptz not null default now(),
  submitted_at timestamptz,
  storage_path text,
  width integer check (width is null or width = 1280),
  height integer check (height is null or height = 720),
  is_blank boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(storyboard_panel_id, game_session_id)
    references public.storyboard_panels(id, game_session_id) on delete cascade,
  unique(game_session_id, participant_id),
  unique(game_session_id, storyboard_panel_id),
  unique(id, game_session_id)
);
create index drawing_assignments_game_status_idx
  on public.drawing_assignments(game_session_id, status);
create index drawing_assignments_participant_idx
  on public.drawing_assignments(participant_id, game_session_id);

alter table public.storyboard_panels enable row level security;
alter table public.drawing_assignments enable row level security;
revoke all on public.storyboard_panels, public.drawing_assignments
  from anon, authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values('game-drawings', 'game-drawings', false, 8388608, array['image/png'])
on conflict(id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.resolve_drawing_phase_internal(p_game_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  target_room uuid;
  expected_count integer;
  resolved_count integer;
begin
  select room_id, player_count into target_room, expected_count
  from public.game_sessions
  where id = p_game_id and phase = 'drawing'
  for update;
  if target_room is null then return false; end if;

  -- Give browsers a short grace period to finish their automatic deadline upload.
  if exists (
    select 1 from public.game_sessions
    where id = p_game_id and drawing_deadline_at + interval '10 seconds' <= now()
  ) then
    update public.drawing_assignments
    set status = 'missing', updated_at = now()
    where game_session_id = p_game_id and status = 'assigned';
  end if;

  select count(*) into resolved_count
  from public.drawing_assignments
  where game_session_id = p_game_id and status <> 'assigned';

  update public.rooms set answer_count = resolved_count where id = target_room;
  if resolved_count < expected_count then return false; end if;

  update public.game_sessions
  set phase = 'drawing_complete', phase_started_at = now(),
      phase_deadline_at = null, updated_at = now()
  where id = p_game_id and phase = 'drawing';
  if not found then return false; end if;
  update public.rooms
  set game_phase = 'drawing_complete', answer_count = expected_count
  where id = target_room;
  return true;
end;
$$;

create or replace function public.complete_story_job(
  p_game_id uuid, p_story jsonb, p_model text, p_usage jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare
  target_room uuid;
  expected_count integer;
  panel_count integer;
begin
  select room_id, player_count into target_room, expected_count
  from public.game_sessions
  where id = p_game_id and phase = 'composing_story'
  for update;
  if target_room is null then raise exception 'GAME_NOT_COMPOSING_STORY'; end if;
  panel_count := jsonb_array_length(p_story->'panels');
  if panel_count <> expected_count then raise exception 'DRAWING_PANEL_COUNT_MISMATCH'; end if;

  insert into public.final_stories(game_session_id, structured_story)
  values(p_game_id, p_story)
  on conflict(game_session_id) do update
    set structured_story = excluded.structured_story, updated_at = now();

  insert into public.storyboard_panels(
    game_session_id, panel_number, narration, dialogue, drawing_brief, story_beat
  )
  select
    p_game_id,
    (panel.value->>'panelNumber')::integer,
    coalesce(panel.value->>'narrationDraft', panel.value->>'narration', ''),
    panel.value->>'dialogue',
    case
      when panel.value ? 'drawingBrief' then panel.value->'drawingBrief'
      else jsonb_build_object('fullPrompt', panel.value->>'drawingCaption')
    end,
    panel.value->>'storyBeat'
  from jsonb_array_elements(p_story->'panels') panel(value)
  on conflict(game_session_id, panel_number) do update set
    narration = excluded.narration,
    dialogue = excluded.dialogue,
    drawing_brief = excluded.drawing_brief,
    story_beat = excluded.story_beat,
    updated_at = now();

  if (
    select count(*) from public.storyboard_panels where game_session_id = p_game_id
  ) <> expected_count then raise exception 'DRAWING_PANEL_PERSISTENCE_FAILED'; end if;

  insert into public.drawing_assignments(
    game_session_id, participant_id, storyboard_panel_id
  )
  select p_game_id, shuffled_participants.id, ordered_panels.id
  from (
    select gp.id, row_number() over(order by gen_random_uuid()) position
    from public.game_participants gp
    where gp.game_session_id = p_game_id and gp.active
  ) shuffled_participants
  join (
    select sp.id, row_number() over(order by sp.panel_number) position
    from public.storyboard_panels sp
    where sp.game_session_id = p_game_id
  ) ordered_panels using(position)
  on conflict do nothing;

  if (
    select count(*) from public.drawing_assignments where game_session_id = p_game_id
  ) <> expected_count then raise exception 'DRAWING_ASSIGNMENT_COUNT_MISMATCH'; end if;

  update public.ai_jobs set status = 'completed', response_payload = p_story,
    model_name = p_model, token_usage = p_usage, completed_at = now()
  where game_session_id = p_game_id and job_type = 'compose_story';
  update public.game_sessions
  set phase = 'drawing', phase_started_at = now(),
      phase_deadline_at = now() + interval '90 seconds',
      drawing_started_at = now(), drawing_deadline_at = now() + interval '90 seconds',
      updated_at = now()
  where id = p_game_id;
  update public.rooms set game_phase = 'drawing', answer_count = 0
  where id = target_room;
end;
$$;

create or replace function public.get_game_state(p_room_id uuid, p_player_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  result jsonb;
  target_game uuid;
  current_phase text;
begin
  select gs.id, gs.phase into target_game, current_phase
  from public.players p
  join public.game_participants gp on gp.player_id = p.id and gp.active
  join public.game_sessions gs on gs.id = gp.game_session_id
    and gs.status in ('active','error')
  where p.room_id = p_room_id and p.client_token = p_player_token
  order by gs.created_at desc limit 1;
  if target_game is null then raise exception 'GAME_NOT_FOUND'; end if;
  if current_phase = 'drawing' then
    perform public.resolve_drawing_phase_internal(target_game);
  end if;

  select jsonb_build_object(
    'gameId', gs.id, 'phase', gs.phase,
    'phaseStartedAt', gs.phase_started_at,
    'phaseDeadlineAt', case when gs.phase = 'drawing'
      then gs.drawing_deadline_at else gs.phase_deadline_at end,
    'playerCount', gs.player_count,
    'answerCount', case
      when gs.phase in ('opening_questions','followup_questions') then
        (select count(*) from public.prompt_assignments x
         where x.game_session_id = gs.id and x.phase = gs.phase
           and x.submitted_at is not null)
      when gs.phase in ('drawing','drawing_complete') then
        (select count(*) from public.drawing_assignments x
         where x.game_session_id = gs.id and x.status <> 'assigned')
      else 0 end,
    'isHost', p.is_host,
    'assignmentId', case when gs.phase in ('drawing','drawing_complete')
      then da.id else pa.id end,
    'promptText', case when gs.phase = 'drawing'
      then coalesce(sp.drawing_brief->>'fullPrompt', sp.drawing_brief->>'drawingCaption')
      else pa.prompt_text end,
    'submittedAt', case when gs.phase in ('drawing','drawing_complete')
      then da.submitted_at else pa.submitted_at end,
    'answerText', ans.answer_text,
    'drawingStatus', da.status,
    'drawingPanelId', da.storyboard_panel_id,
    'aiJobStatus', job.status, 'aiJobType', job.job_type,
    'aiError', case when p.is_host then job.error_message else null end,
    'aiAttemptCount', coalesce(job.attempt_count, 0),
    'story', case when gs.phase = 'story_complete' then story.structured_story else null end
  ) into result
  from public.players p
  join public.game_participants gp on gp.player_id = p.id and gp.active
  join public.game_sessions gs on gs.id = gp.game_session_id
    and gs.status in ('active','error')
  left join public.prompt_assignments pa on pa.participant_id = gp.id
    and pa.game_session_id = gs.id and pa.phase = gs.phase
  left join public.prompt_answers ans on ans.assignment_id = pa.id
  left join public.ai_jobs job on job.game_session_id = gs.id
    and job.job_type = case
      when gs.phase in (
        'composing_story','story_complete','drawing','drawing_complete','drawing_error'
      ) or exists (
        select 1 from public.ai_jobs sj where sj.game_session_id = gs.id
          and sj.job_type = 'compose_story'
      ) then 'compose_story' else 'compose_outline' end
  left join public.final_stories story on story.game_session_id = gs.id
  left join public.drawing_assignments da on da.game_session_id = gs.id
    and da.participant_id = gp.id
  left join public.storyboard_panels sp on sp.id = da.storyboard_panel_id
  where p.room_id = p_room_id and p.client_token = p_player_token
  order by gs.created_at desc limit 1;
  if result is null then raise exception 'GAME_NOT_FOUND'; end if;
  return result;
end;
$$;

create or replace function public.check_game_progress(
  p_game_id uuid, p_player_token uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare current_phase text;
begin
  if not exists (
    select 1 from public.game_participants gp
    join public.players p on p.id = gp.player_id
    where gp.game_session_id = p_game_id and gp.active
      and p.client_token = p_player_token
  ) then raise exception 'NOT_PARTICIPANT'; end if;
  select phase into current_phase from public.game_sessions where id = p_game_id;
  if current_phase = 'opening_questions' then
    return public.advance_opening_phase_internal(p_game_id);
  elsif current_phase = 'followup_questions' then
    return public.advance_followup_phase_internal(p_game_id);
  elsif current_phase = 'drawing' then
    return public.resolve_drawing_phase_internal(p_game_id);
  end if;
  return false;
end;
$$;

create or replace function public.prepare_drawing_submission(
  p_game_id uuid, p_assignment_id uuid, p_player_token uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  assignment_record public.drawing_assignments;
  deadline timestamptz;
begin
  select da.* into assignment_record
  from public.drawing_assignments da
  join public.game_participants gp on gp.id = da.participant_id and gp.active
  join public.players p on p.id = gp.player_id
  where da.id = p_assignment_id and da.game_session_id = p_game_id
    and p.client_token = p_player_token;
  if not found then raise exception 'DRAWING_ASSIGNMENT_NOT_FOUND'; end if;
  select drawing_deadline_at into deadline from public.game_sessions
  where id = p_game_id and phase = 'drawing';
  if deadline is null then
    if assignment_record.status in ('submitted','blank') then
      return jsonb_build_object(
        'status', assignment_record.status,
        'storagePath', assignment_record.storage_path
      );
    end if;
    raise exception 'DRAWING_PHASE_CLOSED';
  end if;
  if now() > deadline + interval '10 seconds' then
    perform public.resolve_drawing_phase_internal(p_game_id);
    raise exception 'DRAWING_DEADLINE_EXPIRED';
  end if;
  return jsonb_build_object(
    'status', assignment_record.status,
    'storagePath', p_game_id::text || '/' || p_assignment_id::text || '/drawing.png'
  );
end;
$$;

create or replace function public.complete_drawing_submission(
  p_game_id uuid, p_assignment_id uuid, p_player_token uuid,
  p_storage_path text, p_width integer, p_height integer, p_is_blank boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  target_room uuid;
  final_status text;
begin
  if p_width <> 1280 or p_height <> 720 then raise exception 'INVALID_DRAWING_SIZE'; end if;
  if p_storage_path <> (p_game_id::text || '/' || p_assignment_id::text || '/drawing.png')
    then raise exception 'INVALID_DRAWING_PATH'; end if;
  if not exists (
    select 1 from public.drawing_assignments da
    join public.game_participants gp on gp.id = da.participant_id and gp.active
    join public.players p on p.id = gp.player_id
    where da.id = p_assignment_id and da.game_session_id = p_game_id
      and p.client_token = p_player_token
  ) then raise exception 'DRAWING_ASSIGNMENT_NOT_FOUND'; end if;
  final_status := case when p_is_blank then 'blank' else 'submitted' end;
  update public.drawing_assignments
  set status = case when status in ('submitted','blank') then status else final_status end,
      submitted_at = coalesce(submitted_at, now()),
      storage_path = coalesce(storage_path, p_storage_path),
      width = coalesce(width, p_width), height = coalesce(height, p_height),
      is_blank = case when status in ('submitted','blank') then is_blank else p_is_blank end,
      updated_at = now()
  where id = p_assignment_id and game_session_id = p_game_id
  returning status into final_status;
  select room_id into target_room from public.game_sessions where id = p_game_id;
  update public.rooms set answer_count = (
    select count(*) from public.drawing_assignments
    where game_session_id = p_game_id and status <> 'assigned'
  ) where id = target_room;
  perform public.resolve_drawing_phase_internal(p_game_id);
  return jsonb_build_object('status', final_status);
end;
$$;

create or replace function public.get_premiere_panels(p_game_id uuid)
returns jsonb language sql security definer set search_path = '' stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'panelId', sp.id,
    'panelNumber', sp.panel_number,
    'narration', sp.narration,
    'dialogue', sp.dialogue,
    'drawingBrief', sp.drawing_brief,
    'drawingStoragePath', da.storage_path,
    'drawingStatus', da.status,
    'artistParticipantId', da.participant_id,
    'artistUsername', p.name
  ) order by sp.panel_number), '[]'::jsonb)
  from public.storyboard_panels sp
  join public.drawing_assignments da on da.storyboard_panel_id = sp.id
    and da.game_session_id = sp.game_session_id
  join public.game_participants gp on gp.id = da.participant_id
  join public.players p on p.id = gp.player_id
  where sp.game_session_id = p_game_id;
$$;

revoke all on function public.resolve_drawing_phase_internal(uuid) from public;
revoke all on function public.complete_story_job(uuid,jsonb,text,jsonb) from public;
revoke all on function public.prepare_drawing_submission(uuid,uuid,uuid) from public;
revoke all on function public.complete_drawing_submission(uuid,uuid,uuid,text,integer,integer,boolean) from public;
revoke all on function public.get_premiere_panels(uuid) from public;
grant execute on function public.complete_story_job(uuid,jsonb,text,jsonb) to service_role;
grant execute on function public.prepare_drawing_submission(uuid,uuid,uuid) to service_role;
grant execute on function public.complete_drawing_submission(uuid,uuid,uuid,text,integer,integer,boolean) to service_role;
grant execute on function public.get_premiere_panels(uuid) to service_role;

-- Synchronized, audio-narrated Premiere. Media remains private and is exposed
-- only as short-lived signed URLs after a participant token is validated.

alter table public.rooms drop constraint if exists rooms_game_phase_check;
alter table public.rooms add constraint rooms_game_phase_check check (game_phase in (
  'lobby','opening_questions','composing_outline','followup_questions',
  'composing_story','story_complete','drawing','drawing_complete','drawing_error',
  'premiere_preparing','premiere_ready','premiere_playing','game_complete',
  'premiere_error','error'
));
alter table public.game_sessions drop constraint if exists game_sessions_phase_check;
alter table public.game_sessions add constraint game_sessions_phase_check check (phase in (
  'lobby','opening_questions','composing_outline','followup_questions',
  'composing_story','story_complete','drawing','drawing_complete','drawing_error',
  'premiere_preparing','premiere_ready','premiere_playing','game_complete',
  'premiere_error','error'
));
alter table public.game_sessions
  add column if not exists premiere_started_at timestamptz,
  add column if not exists premiere_ends_at timestamptz;

create table public.narration_clips (
  id uuid primary key default gen_random_uuid(),
  game_session_id uuid not null references public.game_sessions(id) on delete cascade,
  storyboard_panel_id uuid not null references public.storyboard_panels(id) on delete cascade,
  narration_text text not null,
  audio_storage_path text,
  duration_ms integer check(duration_ms is null or duration_ms > 0),
  generation_status text not null default 'pending'
    check(generation_status in ('pending','generating','ready','failed')),
  model_name text,
  voice_name text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(game_session_id, storyboard_panel_id)
);
create index narration_clips_game_idx on public.narration_clips(game_session_id, generation_status);

create table public.premiere_timelines (
  game_session_id uuid primary key references public.game_sessions(id) on delete cascade,
  timeline jsonb not null,
  total_duration_ms integer not null check(total_duration_ms > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.narration_clips enable row level security;
alter table public.premiere_timelines enable row level security;
revoke all on public.narration_clips, public.premiere_timelines from anon, authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('premiere-audio','premiere-audio',false,10485760,array['audio/wav'])
on conflict(id) do update set public=false, file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

create or replace function public.request_premiere_preparation(
  p_game_id uuid, p_player_token uuid
) returns boolean language plpgsql security definer set search_path='' as $$
declare target_room uuid;
begin
  select gs.room_id into target_room
  from public.game_sessions gs
  join public.game_participants gp on gp.game_session_id=gs.id and gp.active
  join public.players p on p.id=gp.player_id
  where gs.id=p_game_id and p.client_token=p_player_token and p.is_host;
  if target_room is null then raise exception 'HOST_ONLY'; end if;
  update public.game_sessions set phase='premiere_preparing',updated_at=now()
  where id=p_game_id and phase in ('drawing_complete','premiere_error');
  if found then
    update public.rooms set game_phase='premiere_preparing' where id=target_room;
    return true;
  end if;
  return exists(select 1 from public.game_sessions where id=p_game_id
    and phase in ('premiere_preparing','premiere_ready','premiere_playing','game_complete'));
end $$;

create or replace function public.complete_premiere_preparation(
  p_game_id uuid, p_clips jsonb, p_timeline jsonb, p_total_duration_ms integer
) returns void language plpgsql security definer set search_path='' as $$
declare target_room uuid; clip jsonb;
begin
  select room_id into target_room from public.game_sessions
  where id=p_game_id and phase in ('premiere_preparing','premiere_ready') for update;
  if target_room is null then raise exception 'PREMIERE_NOT_PREPARING'; end if;
  for clip in select value from jsonb_array_elements(p_clips)
  loop
    insert into public.narration_clips(
      game_session_id,storyboard_panel_id,narration_text,audio_storage_path,
      duration_ms,generation_status,model_name,voice_name
    ) values(
      p_game_id,(clip->>'panelId')::uuid,clip->>'narration',clip->>'audioStoragePath',
      (clip->>'durationMs')::integer,coalesce(clip->>'status','ready'),clip->>'model',clip->>'voice'
    ) on conflict(game_session_id,storyboard_panel_id) do update set
      narration_text=excluded.narration_text,audio_storage_path=excluded.audio_storage_path,
      duration_ms=excluded.duration_ms,generation_status=excluded.generation_status,
      model_name=excluded.model_name,voice_name=excluded.voice_name,
      error_message=null,updated_at=now();
  end loop;
  insert into public.premiere_timelines(game_session_id,timeline,total_duration_ms)
  values(p_game_id,p_timeline,p_total_duration_ms)
  on conflict(game_session_id) do update set timeline=excluded.timeline,
    total_duration_ms=excluded.total_duration_ms,updated_at=now();
  update public.game_sessions set phase='premiere_ready',updated_at=now()
  where id=p_game_id and phase='premiere_preparing';
  update public.rooms set game_phase='premiere_ready' where id=target_room;
end $$;

create or replace function public.fail_premiere_preparation(p_game_id uuid,p_error text)
returns void language plpgsql security definer set search_path='' as $$
declare target_room uuid;
begin
  update public.game_sessions set phase='premiere_error',updated_at=now()
  where id=p_game_id and phase='premiere_preparing' returning room_id into target_room;
  if target_room is not null then
    update public.rooms set game_phase='premiere_error' where id=target_room;
  end if;
end $$;

create or replace function public.start_premiere(p_game_id uuid,p_player_token uuid)
returns timestamptz language plpgsql security definer set search_path='' as $$
declare target_room uuid; starts timestamptz; duration integer;
begin
  select gs.room_id,pt.total_duration_ms into target_room,duration
  from public.game_sessions gs join public.premiere_timelines pt on pt.game_session_id=gs.id
  join public.game_participants gp on gp.game_session_id=gs.id and gp.active
  join public.players p on p.id=gp.player_id
  where gs.id=p_game_id and p.client_token=p_player_token and p.is_host;
  if target_room is null then raise exception 'HOST_ONLY'; end if;
  select premiere_started_at into starts from public.game_sessions where id=p_game_id for update;
  if starts is not null then return starts; end if;
  starts:=now()+interval '3 seconds';
  update public.game_sessions set phase='premiere_playing',premiere_started_at=starts,
    premiere_ends_at=starts+(duration*interval '1 millisecond'),updated_at=now()
  where id=p_game_id and phase='premiere_ready';
  if not found then raise exception 'PREMIERE_NOT_READY'; end if;
  update public.rooms set game_phase='premiere_playing' where id=target_room;
  return starts;
end $$;

create or replace function public.finish_premiere(p_game_id uuid,p_player_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare target_room uuid;
begin
  select gs.room_id into target_room from public.game_sessions gs
  join public.game_participants gp on gp.game_session_id=gs.id and gp.active
  join public.players p on p.id=gp.player_id
  where gs.id=p_game_id and p.client_token=p_player_token;
  if target_room is null then raise exception 'NOT_PARTICIPANT'; end if;
  update public.game_sessions set phase='game_complete',updated_at=now()
  where id=p_game_id and phase='premiere_playing' and premiere_ends_at<=now();
  if found then update public.rooms set game_phase='game_complete' where id=target_room; return true; end if;
  return false;
end $$;

create or replace function public.skip_premiere_to_credits(p_game_id uuid,p_player_token uuid)
returns timestamptz language plpgsql security definer set search_path='' as $$
declare credits_at integer; duration integer; target_room uuid; starts timestamptz;
begin
  select (segment->>'startMs')::integer,pt.total_duration_ms,gs.room_id
  into credits_at,duration,target_room
  from public.game_sessions gs
  join public.premiere_timelines pt on pt.game_session_id=gs.id
  join public.game_participants gp on gp.game_session_id=gs.id and gp.active
  join public.players p on p.id=gp.player_id
  cross join lateral jsonb_array_elements(pt.timeline->'segments') segment
  where gs.id=p_game_id and gs.phase='premiere_playing'
    and segment->>'type'='credits' and p.client_token=p_player_token and p.is_host
  limit 1;
  if target_room is null then raise exception 'HOST_ONLY'; end if;
  starts:=now()-(credits_at*interval '1 millisecond');
  update public.game_sessions set premiere_started_at=starts,
    premiere_ends_at=starts+(duration*interval '1 millisecond'),
    phase_started_at=now(),updated_at=now() where id=p_game_id;
  update public.rooms set game_phase=game_phase where id=target_room;
  return starts;
end $$;

create or replace function public.get_premiere_payload(
  p_game_id uuid,p_player_token uuid
) returns jsonb language plpgsql security definer set search_path='' stable as $$
declare payload jsonb;
begin
  if not exists(select 1 from public.game_participants gp join public.players p on p.id=gp.player_id
    where gp.game_session_id=p_game_id and gp.active and p.client_token=p_player_token)
  then raise exception 'NOT_PARTICIPANT'; end if;
  select jsonb_build_object(
    'title',fs.structured_story->>'title','phase',gs.phase,
    'startedAt',gs.premiere_started_at,'endsAt',gs.premiere_ends_at,
    'timeline',pt.timeline,'totalDurationMs',pt.total_duration_ms,
    'players',(select jsonb_agg(p.name order by gp.seat_number)
      from public.game_participants gp join public.players p on p.id=gp.player_id
      where gp.game_session_id=gs.id),
    'panels',(select jsonb_agg(jsonb_build_object(
      'panelId',sp.id,'panelNumber',sp.panel_number,'narration',sp.narration,
      'dialogue',sp.dialogue,'drawingStatus',da.status,
      'drawingStoragePath',da.storage_path,'artistUsername',p.name,
      'audioStoragePath',nc.audio_storage_path,'audioDurationMs',nc.duration_ms
    ) order by sp.panel_number)
      from public.storyboard_panels sp
      join public.drawing_assignments da on da.storyboard_panel_id=sp.id
      join public.game_participants gp on gp.id=da.participant_id
      join public.players p on p.id=gp.player_id
      left join public.narration_clips nc on nc.storyboard_panel_id=sp.id
      where sp.game_session_id=gs.id)
  ) into payload
  from public.game_sessions gs
  join public.final_stories fs on fs.game_session_id=gs.id
  left join public.premiere_timelines pt on pt.game_session_id=gs.id
  where gs.id=p_game_id;
  return payload;
end $$;

create or replace function public.replay_to_lobby(p_game_id uuid,p_player_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare target_room uuid;
begin
  select gs.room_id into target_room from public.game_sessions gs
  join public.game_participants gp on gp.game_session_id=gs.id
  join public.players p on p.id=gp.player_id
  where gs.id=p_game_id and p.client_token=p_player_token and p.is_host;
  if target_room is null then raise exception 'HOST_ONLY'; end if;
  update public.game_sessions set status='completed',updated_at=now() where id=p_game_id;
  update public.game_participants set active=false where game_session_id=p_game_id;
  update public.rooms set status='open',game_phase='lobby',answer_count=0,started_at=null
  where id=target_room;
  return true;
end $$;

revoke all on function public.complete_premiere_preparation(uuid,jsonb,jsonb,integer) from public;
revoke all on function public.fail_premiere_preparation(uuid,text) from public;
revoke all on function public.get_premiere_payload(uuid,uuid) from public;
grant execute on function public.complete_premiere_preparation(uuid,jsonb,jsonb,integer) to service_role;
grant execute on function public.fail_premiere_preparation(uuid,text) to service_role;
grant execute on function public.get_premiere_payload(uuid,uuid) to service_role;
grant execute on function public.request_premiere_preparation(uuid,uuid) to anon,authenticated;
grant execute on function public.start_premiere(uuid,uuid) to anon,authenticated;
grant execute on function public.finish_premiere(uuid,uuid) to anon,authenticated;
grant execute on function public.skip_premiere_to_credits(uuid,uuid) to anon,authenticated;
grant execute on function public.replay_to_lobby(uuid,uuid) to anon,authenticated;

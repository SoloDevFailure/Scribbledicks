-- A synchronized five-second intermission between drawing rounds.

alter table public.rooms drop constraint if exists rooms_game_phase_check;
alter table public.rooms add constraint rooms_game_phase_check check (game_phase in (
  'lobby','opening_questions','composing_outline','followup_questions',
  'composing_story','story_complete','drawing','drawing_intermission',
  'drawing_complete','drawing_error','premiere_preparing','premiere_ready',
  'premiere_playing','game_complete','premiere_error','error'
));
alter table public.game_sessions drop constraint if exists game_sessions_phase_check;
alter table public.game_sessions add constraint game_sessions_phase_check check (phase in (
  'lobby','opening_questions','composing_outline','followup_questions',
  'composing_story','story_complete','drawing','drawing_intermission',
  'drawing_complete','drawing_error','premiere_preparing','premiere_ready',
  'premiere_playing','game_complete','premiere_error','error'
));

create or replace function public.advance_drawing_intermission_internal(p_game_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare target_room uuid;
begin
  update public.game_sessions
  set phase='drawing',phase_started_at=now(),
      phase_deadline_at=now()+interval '90 seconds',
      drawing_started_at=now(),drawing_deadline_at=now()+interval '90 seconds',
      updated_at=now()
  where id=p_game_id and phase='drawing_intermission' and phase_deadline_at<=now()
  returning room_id into target_room;
  if target_room is null then return false; end if;
  update public.rooms set game_phase='drawing',answer_count=0 where id=target_room;
  return true;
end $$;

create or replace function public.resolve_drawing_phase_internal(p_game_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  target_room uuid; expected_count integer; current_round integer;
  total_rounds integer; resolved_count integer;
begin
  select room_id,player_count,drawing_round_number,drawing_round_count
  into target_room,expected_count,current_round,total_rounds
  from public.game_sessions where id=p_game_id and phase='drawing' for update;
  if target_room is null then return false; end if;

  if exists(select 1 from public.game_sessions
    where id=p_game_id and drawing_deadline_at+interval '10 seconds'<=now()) then
    update public.drawing_assignments set status='missing',updated_at=now()
    where game_session_id=p_game_id and round_number=current_round and status='assigned';
  end if;
  select count(*) into resolved_count from public.drawing_assignments
  where game_session_id=p_game_id and round_number=current_round and status<>'assigned';
  update public.rooms set answer_count=resolved_count where id=target_room;
  if resolved_count<expected_count then return false; end if;

  if current_round<total_rounds then
    update public.game_sessions
    set phase='drawing_intermission',drawing_round_number=current_round+1,
        phase_started_at=now(),phase_deadline_at=now()+interval '5 seconds',
        drawing_deadline_at=null,updated_at=now()
    where id=p_game_id and phase='drawing' and drawing_round_number=current_round;
    if not found then return false; end if;
    update public.rooms set game_phase='drawing_intermission',answer_count=0 where id=target_room;
    return true;
  end if;

  update public.game_sessions set phase='drawing_complete',phase_started_at=now(),
    phase_deadline_at=null,updated_at=now()
  where id=p_game_id and phase='drawing' and drawing_round_number=current_round;
  if not found then return false; end if;
  update public.rooms set game_phase='drawing_complete',answer_count=expected_count
  where id=target_room;
  return true;
end $$;

create or replace function public.check_game_progress(p_game_id uuid,p_player_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare current_phase text;
begin
  if not exists(select 1 from public.game_participants gp
    join public.players p on p.id=gp.player_id
    where gp.game_session_id=p_game_id and gp.active and p.client_token=p_player_token)
  then raise exception 'NOT_PARTICIPANT'; end if;
  select phase into current_phase from public.game_sessions where id=p_game_id;
  if current_phase='opening_questions' then
    return public.advance_opening_phase_internal(p_game_id);
  elsif current_phase='followup_questions' then
    return public.advance_followup_phase_internal(p_game_id);
  elsif current_phase='drawing' then
    return public.resolve_drawing_phase_internal(p_game_id);
  elsif current_phase='drawing_intermission' then
    return public.advance_drawing_intermission_internal(p_game_id);
  end if;
  return false;
end $$;

revoke all on function public.advance_drawing_intermission_internal(uuid) from public;
revoke all on function public.resolve_drawing_phase_internal(uuid) from public;
grant execute on function public.check_game_progress(uuid,uuid) to anon,authenticated;

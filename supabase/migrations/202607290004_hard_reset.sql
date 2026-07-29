-- Host-only recovery control for abandoning a failed/incomplete game.
create or replace function public.abandon_game(p_game_id uuid, p_player_token uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_room uuid;
begin
  select gs.room_id into target_room
  from public.game_sessions gs
  join public.game_participants gp on gp.game_session_id = gs.id
  join public.players p on p.id = gp.player_id
  where gs.id = p_game_id
    and p.client_token = p_player_token
    and p.is_host;

  if target_room is null then raise exception 'HOST_ONLY'; end if;

  update public.game_sessions
  set status = 'complete', phase = 'error', updated_at = now()
  where id = p_game_id;

  update public.ai_jobs
  set status = case when status in ('pending', 'running') then 'failed' else status end,
      error_message = coalesce(error_message, 'Game abandoned by host.'),
      completed_at = coalesce(completed_at, now())
  where game_session_id = p_game_id;

  update public.rooms
  set status = 'closed', game_phase = 'error'
  where id = target_room;
end;
$$;

revoke all on function public.abandon_game(uuid, uuid) from public;
grant execute on function public.abandon_game(uuid, uuid) to anon, authenticated;

-- Repairs join_room in databases created with the initial lobby migration.
-- The original ON CONFLICT column list collided with the function's room_id
-- output parameter and caused PostgreSQL error 42702 on every guest join.
create or replace function public.join_room(
  p_room_code text, p_player_name text, p_player_token uuid
)
returns table (
  room_id uuid, room_code text, room_status text,
  player_id uuid, player_name text, is_host boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_room public.rooms;
  joined_player public.players;
begin
  if upper(btrim(p_room_code)) !~ '^[A-Z2-9]{5}$' then raise exception 'INVALID_CODE'; end if;
  if char_length(btrim(p_player_name)) not between 1 and 28 then raise exception 'INVALID_NAME'; end if;

  select * into target_room
  from public.rooms
  where code = upper(btrim(p_room_code));

  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if target_room.status <> 'open' then raise exception 'ROOM_NOT_OPEN'; end if;

  begin
    insert into public.players (room_id, name, client_token)
    values (target_room.id, btrim(p_player_name), p_player_token)
    on conflict on constraint players_room_id_client_token_key
    do update set last_seen_at = now()
    returning * into joined_player;
  exception when unique_violation then
    raise exception 'NAME_TAKEN';
  end;

  return query
  select target_room.id, target_room.code, target_room.status,
    joined_player.id, joined_player.name, joined_player.is_host;
end;
$$;

revoke all on function public.join_room(text, text, uuid) from public;
grant execute on function public.join_room(text, text, uuid) to anon, authenticated;

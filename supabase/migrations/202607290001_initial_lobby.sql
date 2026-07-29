-- Scribbledicks milestone 1: rooms and players only.
create extension if not exists pgcrypto;

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z2-9]{5}$'),
  status text not null default 'open' check (status in ('open', 'started', 'closed')),
  created_at timestamptz not null default now(),
  started_at timestamptz
);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 28),
  client_token uuid not null,
  is_host boolean not null default false,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (room_id, client_token)
);

create unique index players_one_host_per_room
  on public.players (room_id) where is_host;
create unique index players_unique_name_per_room
  on public.players (room_id, lower(btrim(name)));
create index players_room_joined_idx on public.players (room_id, joined_at);
create index rooms_status_idx on public.rooms (status);

alter table public.rooms enable row level security;
alter table public.players enable row level security;

-- The browser may read lobby-safe columns only. Mutations go through validated RPCs.
grant select (id, code, status, created_at, started_at) on public.rooms to anon, authenticated;
grant select (id, room_id, name, is_host, joined_at, last_seen_at) on public.players to anon, authenticated;
revoke all on public.rooms from anon, authenticated;
revoke all on public.players from anon, authenticated;
grant select (id, code, status, created_at, started_at) on public.rooms to anon, authenticated;
grant select (id, room_id, name, is_host, joined_at, last_seen_at) on public.players to anon, authenticated;

create policy "Lobby rooms are readable"
  on public.rooms for select to anon, authenticated using (true);
create policy "Lobby players are readable"
  on public.players for select to anon, authenticated using (true);

create or replace function public.generate_room_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text := '';
  i integer;
begin
  for i in 1..5 loop
    result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::integer, 1);
  end loop;
  return result;
end;
$$;

create or replace function public.create_room(p_player_name text, p_player_token uuid)
returns table (
  room_id uuid, room_code text, room_status text,
  player_id uuid, player_name text, is_host boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_room public.rooms;
  new_player public.players;
  attempts integer := 0;
begin
  if char_length(btrim(p_player_name)) not between 1 and 28 then
    raise exception 'INVALID_NAME';
  end if;
  loop
    attempts := attempts + 1;
    begin
      insert into public.rooms (code) values (public.generate_room_code())
      returning * into new_room;
      exit;
    exception when unique_violation then
      if attempts >= 10 then raise exception 'ROOM_CODE_EXHAUSTED'; end if;
    end;
  end loop;
  insert into public.players (room_id, name, client_token, is_host)
  values (new_room.id, btrim(p_player_name), p_player_token, true)
  returning * into new_player;
  return query select new_room.id, new_room.code, new_room.status,
    new_player.id, new_player.name, new_player.is_host;
end;
$$;

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
  select * into target_room from public.rooms where code = upper(btrim(p_room_code));
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
  return query select target_room.id, target_room.code, target_room.status,
    joined_player.id, joined_player.name, joined_player.is_host;
end;
$$;

create or replace function public.start_room(p_room_id uuid, p_player_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.players
    where room_id = p_room_id and client_token = p_player_token and is_host
  ) then raise exception 'HOST_ONLY'; end if;
  update public.rooms
  set status = 'started', started_at = coalesce(started_at, now())
  where id = p_room_id and status = 'open';
end;
$$;

create or replace function public.touch_player(p_room_id uuid, p_player_token uuid)
returns void language sql security definer set search_path = '' as $$
  update public.players set last_seen_at = now()
  where room_id = p_room_id and client_token = p_player_token;
$$;

create or replace function public.leave_room(p_room_id uuid, p_player_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare leaving_host boolean;
begin
  select is_host into leaving_host from public.players
  where room_id = p_room_id and client_token = p_player_token;
  delete from public.players where room_id = p_room_id and client_token = p_player_token;
  if coalesce(leaving_host, false) then
    update public.rooms set status = 'closed' where id = p_room_id;
  end if;
end;
$$;

revoke all on function public.generate_room_code() from public;
revoke all on function public.create_room(text, uuid) from public;
revoke all on function public.join_room(text, text, uuid) from public;
revoke all on function public.start_room(uuid, uuid) from public;
revoke all on function public.touch_player(uuid, uuid) from public;
revoke all on function public.leave_room(uuid, uuid) from public;
grant execute on function public.create_room(text, uuid) to anon, authenticated;
grant execute on function public.join_room(text, text, uuid) to anon, authenticated;
grant execute on function public.start_room(uuid, uuid) to anon, authenticated;
grant execute on function public.touch_player(uuid, uuid) to anon, authenticated;
grant execute on function public.leave_room(uuid, uuid) to anon, authenticated;

-- Required for Supabase Realtime Postgres Changes.
alter publication supabase_realtime add table public.rooms;
alter publication supabase_realtime add table public.players;

-- Run after migration 003 in a development Supabase SQL Editor.
-- Everything is rolled back, including the temporary rooms and players.
begin;

do $$
declare
  room3 uuid;
  room6 uuid;
  game3 uuid;
  game6 uuid;
  host3 constant uuid := '00000000-0000-4000-8000-000000000003';
  host6 constant uuid := '00000000-0000-4000-8000-000000000006';
  token_value uuid;
  i integer;
begin
  insert into public.rooms(code) values ('TSTAA') returning id into room3;
  insert into public.players(room_id, name, client_token, is_host)
  values (room3, 'Host 3', host3, true);
  for i in 2..3 loop
    token_value := ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid;
    insert into public.players(room_id, name, client_token)
    values (room3, 'Player 3-' || i, token_value);
  end loop;
  game3 := public.start_game(room3, host3);
  if (select count(*) from public.game_participants where game_session_id = game3) <> 3 then
    raise exception '3-player participant freeze failed';
  end if;
  if (select count(*) from public.prompt_assignments where game_session_id = game3) <> 3 then
    raise exception '3-player assignment count failed';
  end if;
  if (select count(distinct role_key) from public.prompt_assignments where game_session_id = game3) <> 3 then
    raise exception '3-player roles are not unique';
  end if;
  if not (
    select array_agg(role_key order by role_key) =
      array['CHARACTER','INCITING_EVENT','SETTING']::text[]
    from public.prompt_assignments where game_session_id = game3
  ) then raise exception 'Foundational roles missing'; end if;

  perform public.submit_opening_answer(game3, host3, 'Host answer');
  for i in 2..3 loop
    token_value := ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid;
    perform public.submit_opening_answer(game3, token_value, 'Answer ' || i);
  end loop;
  if (select phase from public.game_sessions where id = game3) <> 'composing_outline' then
    raise exception 'All-answer early progression failed';
  end if;
  if (select count(*) from public.ai_jobs where game_session_id = game3) <> 1 then
    raise exception 'Idempotent AI job creation failed';
  end if;

  insert into public.rooms(code) values ('TSTBB') returning id into room6;
  insert into public.players(room_id, name, client_token, is_host)
  values (room6, 'Host 6', host6, true);
  for i in 2..6 loop
    token_value := ('10000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid;
    insert into public.players(room_id, name, client_token)
    values (room6, 'Player 6-' || i, token_value);
  end loop;
  game6 := public.start_game(room6, host6);
  if (select count(*) from public.prompt_assignments where game_session_id = game6) <> 6 then
    raise exception '6-player assignment count failed';
  end if;
  if (select count(distinct role_key) from public.prompt_assignments where game_session_id = game6) <> 6 then
    raise exception '6-player roles are not unique';
  end if;
  update public.game_sessions set phase_deadline_at = now() - interval '1 second' where id = game6;
  perform public.check_game_progress(game6, host6);
  if (select phase from public.game_sessions where id = game6) <> 'composing_outline' then
    raise exception 'Deadline progression with missing answers failed';
  end if;
  perform public.check_game_progress(game6, host6);
  if (select count(*) from public.ai_jobs where game_session_id = game6) <> 1 then
    raise exception 'Repeated progression duplicated an AI job';
  end if;
end;
$$;

rollback;

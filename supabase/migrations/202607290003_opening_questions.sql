-- Gameplay wave 1: frozen participants, private opening questions, timed
-- submission, idempotent progression, and one outline AI job.

alter table public.rooms
  add column if not exists game_phase text not null default 'lobby'
    check (game_phase in ('lobby', 'opening_questions', 'composing_outline', 'opening_complete', 'error')),
  add column if not exists answer_count integer not null default 0 check (answer_count >= 0);

grant select (game_phase, answer_count) on public.rooms to anon, authenticated;

create table public.game_sessions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'complete', 'error')),
  player_count integer not null check (player_count >= 3),
  phase text not null default 'opening_questions'
    check (phase in ('lobby', 'opening_questions', 'composing_outline', 'opening_complete', 'error')),
  phase_started_at timestamptz not null,
  phase_deadline_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index game_sessions_one_active_room
  on public.game_sessions(room_id) where status = 'active';
create index game_sessions_room_idx on public.game_sessions(room_id, created_at desc);

create table public.game_participants (
  id uuid primary key default gen_random_uuid(),
  game_session_id uuid not null references public.game_sessions(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete restrict,
  seat_number integer not null check (seat_number > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (game_session_id, player_id),
  unique (game_session_id, seat_number)
);
create index game_participants_player_idx on public.game_participants(player_id, game_session_id);

create table public.prompt_assignments (
  id uuid primary key default gen_random_uuid(),
  game_session_id uuid not null references public.game_sessions(id) on delete cascade,
  participant_id uuid not null references public.game_participants(id) on delete cascade,
  phase text not null check (phase = 'opening_questions'),
  role_key text not null,
  prompt_text text not null,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (game_session_id, participant_id, phase),
  unique (game_session_id, phase, role_key)
);
create index prompt_assignments_participant_idx on public.prompt_assignments(participant_id);

create table public.prompt_answers (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null unique references public.prompt_assignments(id) on delete cascade,
  participant_id uuid not null references public.game_participants(id) on delete cascade,
  answer_text text not null check (char_length(btrim(answer_text)) between 1 and 250),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (assignment_id, participant_id)
);

create table public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  game_session_id uuid not null references public.game_sessions(id) on delete cascade,
  job_type text not null check (job_type = 'compose_outline'),
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  request_payload jsonb,
  response_payload jsonb,
  error_message text,
  attempt_count integer not null default 0 check (attempt_count between 0 and 3),
  model_name text,
  token_usage jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique (game_session_id, job_type)
);
create index ai_jobs_game_status_idx on public.ai_jobs(game_session_id, status);

create table public.story_outlines (
  id uuid primary key default gen_random_uuid(),
  game_session_id uuid not null unique references public.game_sessions(id) on delete cascade,
  structured_outline jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.game_sessions enable row level security;
alter table public.game_participants enable row level security;
alter table public.prompt_assignments enable row level security;
alter table public.prompt_answers enable row level security;
alter table public.ai_jobs enable row level security;
alter table public.story_outlines enable row level security;

-- No direct browser table access. Every player-facing read/write is performed
-- by a token-validating security-definer RPC below.
revoke all on public.game_sessions, public.game_participants,
  public.prompt_assignments, public.prompt_answers, public.ai_jobs,
  public.story_outlines from anon, authenticated;

create or replace function public.advance_opening_phase_internal(p_game_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  advanced boolean := false;
  target_room uuid;
begin
  update public.game_sessions gs
  set phase = 'composing_outline',
      phase_started_at = now(),
      phase_deadline_at = null,
      updated_at = now()
  where gs.id = p_game_id
    and gs.phase = 'opening_questions'
    and (
      gs.phase_deadline_at <= now()
      or (select count(*) from public.prompt_assignments pa
          where pa.game_session_id = gs.id and pa.submitted_at is not null) >= gs.player_count
    )
  returning gs.room_id into target_room;

  if target_room is not null then
    insert into public.ai_jobs (game_session_id, job_type)
    values (p_game_id, 'compose_outline')
    on conflict (game_session_id, job_type) do nothing;
    update public.rooms
    set game_phase = 'composing_outline'
    where id = target_room;
    advanced := true;
  end if;
  return advanced;
end;
$$;

create or replace function public.start_game(p_room_id uuid, p_player_token uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_game public.game_sessions;
  participant_count integer;
  participant_record record;
  role_keys text[] := array[
    'CHARACTER','SETTING','INCITING_EVENT','ANTAGONIST','GOAL','OBSTACLE',
    'OBJECT','TIME','CONSEQUENCE','HELPER','SECRET','TRANSPORT','TWIST','RULE','REWARD'
  ];
  prompts text[] := array[
    'Who is the main character in this story? It can be a person, fictional character, animal, object, or anything else.',
    'Where does this story begin? Choose any real or fictional location.',
    'What unexpected event happens that sets the story in motion?',
    'Who or what causes the main problem?',
    'What is someone desperately trying to achieve?',
    'What makes the situation much harder than it should be?',
    'What object becomes important to the story?',
    'When does this story take place? It may be a time period, date, season, or particular moment.',
    'What will happen if the problem is not solved?',
    'Who or what unexpectedly helps during the adventure?',
    'What secret is somebody hiding?',
    'How does someone travel during the story?',
    'What completely unexpected complication occurs?',
    'What rule must everyone obey?',
    'What does someone hope to gain if they succeed?'
  ];
  shuffled_indices integer[];
  role_index integer;
begin
  if not exists (
    select 1 from public.players p
    where p.room_id = p_room_id and p.client_token = p_player_token and p.is_host
  ) then raise exception 'HOST_ONLY'; end if;
  if exists (select 1 from public.game_sessions gs where gs.room_id = p_room_id and gs.status = 'active') then
    return (select gs.id from public.game_sessions gs where gs.room_id = p_room_id and gs.status = 'active');
  end if;
  if not exists (
    select 1 from public.rooms r where r.id = p_room_id and r.status = 'open'
  ) then raise exception 'ROOM_NOT_OPEN'; end if;

  select count(*) into participant_count
  from public.players p
  where p.room_id = p_room_id and p.last_seen_at >= now() - interval '90 seconds';
  if participant_count < 3 then raise exception 'MIN_PLAYERS_3'; end if;

  insert into public.game_sessions (
    room_id, player_count, phase, phase_started_at, phase_deadline_at
  ) values (
    p_room_id, participant_count, 'opening_questions', now(), now() + interval '60 seconds'
  ) returning * into new_game;

  insert into public.game_participants (game_session_id, player_id, seat_number)
  select new_game.id, active_players.id,
    row_number() over (order by random())::integer
  from public.players active_players
  where active_players.room_id = p_room_id
    and active_players.last_seen_at >= now() - interval '90 seconds';

  -- Always include the foundational roles for 3 players, then expand from the
  -- ordered pool. Shuffle only the selected roles before assigning seats.
  select array_agg(i order by random()) into shuffled_indices
  from generate_series(1, participant_count) i;

  for participant_record in
    select gp.id, gp.seat_number
    from public.game_participants gp
    where gp.game_session_id = new_game.id
    order by gp.seat_number
  loop
    role_index := shuffled_indices[participant_record.seat_number];
    if role_index <= 15 then
      insert into public.prompt_assignments (
        game_session_id, participant_id, phase, role_key, prompt_text
      ) values (
        new_game.id, participant_record.id, 'opening_questions',
        role_keys[role_index], prompts[role_index]
      );
    else
      insert into public.prompt_assignments (
        game_session_id, participant_id, phase, role_key, prompt_text
      ) values (
        new_game.id, participant_record.id, 'opening_questions',
        'EXTRA_INGREDIENT_' || role_index,
        'Name one detail that could become important during the story.'
      );
    end if;
  end loop;

  update public.rooms
  set status = 'started', started_at = coalesce(started_at, now()),
      game_phase = 'opening_questions', answer_count = 0
  where id = p_room_id and status = 'open';
  return new_game.id;
end;
$$;

create or replace function public.get_game_state(p_room_id uuid, p_player_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare result jsonb;
begin
  select jsonb_build_object(
    'gameId', gs.id,
    'phase', gs.phase,
    'phaseStartedAt', gs.phase_started_at,
    'phaseDeadlineAt', gs.phase_deadline_at,
    'playerCount', gs.player_count,
    'answerCount', (select count(*) from public.prompt_assignments x
                    where x.game_session_id = gs.id and x.submitted_at is not null),
    'isHost', p.is_host,
    'assignmentId', pa.id,
    'promptText', pa.prompt_text,
    'submittedAt', pa.submitted_at,
    'answerText', ans.answer_text,
    'aiJobStatus', job.status,
    'aiError', case when p.is_host then job.error_message else null end,
    'aiAttemptCount', coalesce(job.attempt_count, 0)
  ) into result
  from public.players p
  join public.game_participants gp on gp.player_id = p.id and gp.active
  join public.game_sessions gs on gs.id = gp.game_session_id and gs.status in ('active', 'error')
  left join public.prompt_assignments pa
    on pa.participant_id = gp.id and pa.game_session_id = gs.id
  left join public.prompt_answers ans on ans.assignment_id = pa.id
  left join public.ai_jobs job
    on job.game_session_id = gs.id and job.job_type = 'compose_outline'
  where p.room_id = p_room_id and p.client_token = p_player_token
  order by gs.created_at desc limit 1;
  if result is null then raise exception 'GAME_NOT_FOUND'; end if;
  return result;
end;
$$;

create or replace function public.submit_opening_answer(
  p_game_id uuid, p_player_token uuid, p_answer_text text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare target_assignment public.prompt_assignments;
declare participant_record public.game_participants;
declare clean_answer text := btrim(p_answer_text);
begin
  if char_length(clean_answer) not between 1 and 250 then raise exception 'INVALID_ANSWER'; end if;
  select gp.* into participant_record
  from public.game_participants gp
  join public.players p on p.id = gp.player_id
  where gp.game_session_id = p_game_id and gp.active and p.client_token = p_player_token;
  if not found then raise exception 'NOT_PARTICIPANT'; end if;
  if not exists (
    select 1 from public.game_sessions gs
    where gs.id = p_game_id and gs.phase = 'opening_questions' and gs.phase_deadline_at > now()
  ) then
    perform public.advance_opening_phase_internal(p_game_id);
    raise exception 'SUBMISSIONS_CLOSED';
  end if;
  select pa.* into target_assignment from public.prompt_assignments pa
  where pa.game_session_id = p_game_id and pa.participant_id = participant_record.id;
  insert into public.prompt_answers (assignment_id, participant_id, answer_text)
  values (target_assignment.id, participant_record.id, clean_answer)
  on conflict (assignment_id) do nothing;
  update public.prompt_assignments pa set submitted_at = coalesce(pa.submitted_at, now())
  where pa.id = target_assignment.id;
  update public.rooms r set answer_count = (
    select count(*) from public.prompt_assignments pa
    where pa.game_session_id = p_game_id and pa.submitted_at is not null
  ) where r.id = (select gs.room_id from public.game_sessions gs where gs.id = p_game_id);
  perform public.advance_opening_phase_internal(p_game_id);
  return public.get_game_state(
    (select gs.room_id from public.game_sessions gs where gs.id = p_game_id),
    p_player_token
  );
end;
$$;

create or replace function public.check_game_progress(p_game_id uuid, p_player_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.game_participants gp
    join public.players p on p.id = gp.player_id
    where gp.game_session_id = p_game_id and gp.active and p.client_token = p_player_token
  ) then raise exception 'NOT_PARTICIPANT'; end if;
  return public.advance_opening_phase_internal(p_game_id);
end;
$$;

create or replace function public.retry_outline_job(
  p_game_id uuid, p_player_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.game_participants gp
    join public.players p on p.id = gp.player_id
    where gp.game_session_id = p_game_id and p.client_token = p_player_token and p.is_host
  ) then raise exception 'HOST_ONLY'; end if;
  update public.ai_jobs
  set status = 'pending', error_message = null, started_at = null, completed_at = null
  where game_session_id = p_game_id and status = 'failed' and attempt_count < 3;
  update public.game_sessions set phase = 'composing_outline', status = 'active', updated_at = now()
  where id = p_game_id;
  update public.rooms set game_phase = 'composing_outline'
  where id = (select room_id from public.game_sessions where id = p_game_id);
end;
$$;

-- Edge-function-only RPCs. They remain unavailable to anon/authenticated.
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
    'gameId', gs.id, 'playerCount', gs.player_count, 'tone', 'comedic',
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

create or replace function public.complete_outline_job(
  p_game_id uuid, p_outline jsonb, p_model text, p_usage jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare target_room uuid;
begin
  insert into public.story_outlines(game_session_id, structured_outline)
  values (p_game_id, p_outline)
  on conflict (game_session_id) do update
    set structured_outline = excluded.structured_outline, updated_at = now();
  update public.ai_jobs set status = 'completed', response_payload = p_outline,
    model_name = p_model, token_usage = p_usage, completed_at = now()
  where game_session_id = p_game_id;
  update public.game_sessions set phase = 'opening_complete', updated_at = now()
  where id = p_game_id returning room_id into target_room;
  update public.rooms set game_phase = 'opening_complete' where id = target_room;
end;
$$;

create or replace function public.fail_outline_job(p_game_id uuid, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
declare target_room uuid;
begin
  update public.ai_jobs set status = 'failed', error_message = left(p_error, 500), completed_at = now()
  where game_session_id = p_game_id;
  update public.game_sessions set phase = 'error', updated_at = now()
  where id = p_game_id returning room_id into target_room;
  update public.rooms set game_phase = 'error' where id = target_room;
end;
$$;

revoke all on function public.advance_opening_phase_internal(uuid) from public;
revoke all on function public.start_game(uuid, uuid) from public;
revoke all on function public.get_game_state(uuid, uuid) from public;
revoke all on function public.submit_opening_answer(uuid, uuid, text) from public;
revoke all on function public.check_game_progress(uuid, uuid) from public;
revoke all on function public.retry_outline_job(uuid, uuid) from public;
revoke all on function public.claim_outline_job(uuid, uuid) from public;
revoke all on function public.complete_outline_job(uuid, jsonb, text, jsonb) from public;
revoke all on function public.fail_outline_job(uuid, text) from public;

grant execute on function public.start_game(uuid, uuid) to anon, authenticated;
grant execute on function public.get_game_state(uuid, uuid) to anon, authenticated;
grant execute on function public.submit_opening_answer(uuid, uuid, text) to anon, authenticated;
grant execute on function public.check_game_progress(uuid, uuid) to anon, authenticated;
grant execute on function public.retry_outline_job(uuid, uuid) to anon, authenticated;
grant execute on function public.claim_outline_job(uuid, uuid) to service_role;
grant execute on function public.complete_outline_job(uuid, jsonb, text, jsonb) to service_role;
grant execute on function public.fail_outline_job(uuid, text) to service_role;

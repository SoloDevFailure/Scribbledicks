-- Give story composition one visible, authoritative 90-second server window.

create or replace function public.advance_followup_phase_internal(p_game_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare target_room uuid;
begin
  update public.game_sessions gs
  set phase = 'composing_story', phase_started_at = now(),
      phase_deadline_at = now() + interval '90 seconds', updated_at = now()
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
  update public.game_sessions set phase = 'composing_story',
    phase_started_at = now(), phase_deadline_at = now() + interval '90 seconds',
    updated_at = now() where id = p_game_id;
  update public.rooms set game_phase = 'composing_story'
  where id = (select room_id from public.game_sessions where id = p_game_id);
end;
$$;

revoke all on function public.advance_followup_phase_internal(uuid) from public;
grant execute on function public.retry_story_job(uuid,uuid) to anon,authenticated;

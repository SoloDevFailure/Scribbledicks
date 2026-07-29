-- Run after migration 006 in a development project. All data is rolled back.
begin;
do $$
declare
  test_room uuid;
  test_game uuid;
  host_token constant uuid := '20000000-0000-4000-8000-000000000001';
  token_two constant uuid := '20000000-0000-4000-8000-000000000002';
  token_three constant uuid := '20000000-0000-4000-8000-000000000003';
  test_outline jsonb := '{
    "workingPremise":"A test premise","protagonistRole":"A protagonist",
    "settingRole":"A setting","centralConflict":"A conflict","goal":null,
    "antagonistRole":null,"importantObjects":[],
    "unresolvedSlots":[
      {"slotKey":"DETAIL_A","genericQuestion":"What does the main character refuse to admit?","purpose":"Character detail"},
      {"slotKey":"DIALOGUE_B","genericQuestion":"Reply to this line: How do you expect to get away with this?","purpose":"Dialogue"},
      {"slotKey":"ENDING_C","genericQuestion":"What finally resolves the main obstacle?","purpose":"Resolution"}
    ]
  }'::jsonb;
  test_story jsonb := '{
    "title":"Test Story","estimatedDurationSeconds":30,
    "panels":[
      {"panelNumber":1,"narration":"The story begins.","dialogue":null,"drawingCaption":"The character at the starting location."},
      {"panelNumber":2,"narration":"The problem becomes clear.","dialogue":"A direct response.","drawingCaption":"The central problem confronting the character."},
      {"panelNumber":3,"narration":"The conflict is resolved.","dialogue":null,"drawingCaption":"The final resolution and all important objects."}
    ]
  }'::jsonb;
begin
  insert into public.rooms(code) values('TSTCC') returning id into test_room;
  insert into public.players(room_id,name,client_token,is_host) values
    (test_room,'Host',host_token,true),
    (test_room,'Two',token_two,false),
    (test_room,'Three',token_three,false);
  test_game := public.start_game(test_room, host_token);
  perform public.submit_opening_answer(test_game, host_token, 'Opening one');
  perform public.submit_opening_answer(test_game, token_two, 'Opening two');
  perform public.submit_opening_answer(test_game, token_three, 'Opening three');
  perform public.complete_outline_job(test_game, test_outline, 'test-model', '{}'::jsonb);
  if (select phase from public.game_sessions where id=test_game) <> 'followup_questions' then
    raise exception 'Follow-up phase did not start';
  end if;
  if (select count(*) from public.prompt_assignments where game_session_id=test_game and phase='followup_questions') <> 3 then
    raise exception 'Expected exactly three follow-up assignments';
  end if;
  perform public.submit_followup_answer(test_game, host_token, 'Follow-up one');
  perform public.submit_followup_answer(test_game, token_two, 'Follow-up two');
  perform public.submit_followup_answer(test_game, token_three, 'Follow-up three');
  if (select phase from public.game_sessions where id=test_game) <> 'composing_story' then
    raise exception 'Story composition phase did not start';
  end if;
  if (select count(*) from public.ai_jobs where game_session_id=test_game and job_type='compose_story') <> 1 then
    raise exception 'Story job was not idempotently created';
  end if;
  perform public.complete_story_job(test_game, test_story, 'test-model', '{}'::jsonb);
  if (select phase from public.game_sessions where id=test_game) <> 'story_complete' then
    raise exception 'Story did not complete';
  end if;
  if (select count(*) from public.final_stories where game_session_id=test_game) <> 1 then
    raise exception 'Final story was not stored';
  end if;
end;
$$;
rollback;

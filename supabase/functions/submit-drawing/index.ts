import { createClient } from 'npm:@supabase/supabase-js@2.111.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405)

  try {
    const form = await request.formData()
    const gameId = String(form.get('gameId') ?? '')
    const assignmentId = String(form.get('assignmentId') ?? '')
    const playerToken = String(form.get('playerToken') ?? '')
    const width = Number(form.get('width'))
    const height = Number(form.get('height'))
    const isBlank = form.get('isBlank') === 'true'
    const drawing = form.get('drawing')

    if (!gameId || !assignmentId || !playerToken) throw new Error('INVALID_DRAWING_REQUEST')
    if (!(drawing instanceof File) || drawing.type !== 'image/png') throw new Error('INVALID_DRAWING_FILE')
    if (drawing.size === 0 || drawing.size > 8 * 1024 * 1024) throw new Error('INVALID_DRAWING_FILE_SIZE')
    if (width !== 1280 || height !== 720) throw new Error('INVALID_DRAWING_SIZE')

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    )
    const { data: prepared, error: prepareError } = await admin.rpc('prepare_drawing_submission', {
      p_game_id: gameId,
      p_assignment_id: assignmentId,
      p_player_token: playerToken,
    })
    if (prepareError) throw prepareError

    const status = String(prepared?.status ?? '')
    const storagePath = String(prepared?.storagePath ?? '')
    if (status === 'submitted' || status === 'blank') {
      return json({ status, alreadySubmitted: true })
    }
    if (!storagePath) throw new Error('DRAWING_PATH_NOT_PREPARED')

    const { error: uploadError } = await admin.storage
      .from('game-drawings')
      .upload(storagePath, drawing, {
        contentType: 'image/png',
        cacheControl: '3600',
        upsert: true,
      })
    if (uploadError) throw uploadError

    const { data: completed, error: completeError } = await admin.rpc('complete_drawing_submission', {
      p_game_id: gameId,
      p_assignment_id: assignmentId,
      p_player_token: playerToken,
      p_storage_path: storagePath,
      p_width: width,
      p_height: height,
      p_is_blank: isBlank,
    })
    if (completeError) throw completeError
    return json(completed)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'DRAWING_SUBMISSION_FAILED'
    console.error('submit-drawing failed', { message })
    return json({ error: message }, 400)
  }
})

import { createClient } from 'npm:@supabase/supabase-js@2.111.0'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json' },
})

function wavDurationMs(bytes: ArrayBuffer): number {
  const view = new DataView(bytes)
  const byteRate = view.getUint32(28, true)
  let offset = 12
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1),
      view.getUint8(offset + 2), view.getUint8(offset + 3),
    )
    const size = view.getUint32(offset + 4, true)
    if (id === 'data') return Math.max(1, Math.round(size / byteRate * 1000))
    offset += 8 + size + (size % 2)
  }
  throw new Error('INVALID_NARRATION_AUDIO')
}

function motions(panelNumber: number, durationMs: number) {
  const choices = ['zoom-in', 'pan-left', 'zoom-out', 'pan-right', 'drift-up', 'drift-down']
  const count = Math.max(1, Math.ceil(durationMs / 4000))
  return Array.from({ length: count }, (_, index) => ({
    startMs: Math.round(index * durationMs / count),
    endMs: Math.round((index + 1) * durationMs / count),
    motion: choices[(panelNumber + index) % choices.length],
  }))
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405)
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )
  let gameId = ''
  let claimed = false
  try {
    const body = await request.json()
    gameId = String(body.gameId ?? '')
    const playerToken = String(body.playerToken ?? '')
    if (!gameId || !playerToken) throw new Error('INVALID_PREMIERE_REQUEST')

    const { error: requestError } = await admin.rpc('request_premiere_preparation', {
      p_game_id: gameId, p_player_token: playerToken,
    })
    if (requestError) throw requestError
    claimed = true
    const { data: payload, error: payloadError } = await admin.rpc('get_premiere_payload', {
      p_game_id: gameId, p_player_token: playerToken,
    })
    if (payloadError) throw payloadError
    if (payload?.phase === 'premiere_playing' || payload?.phase === 'game_complete') {
      return json({ phase: payload.phase, startedAt: payload.startedAt })
    }

    const model = Deno.env.get('OPENAI_TTS_MODEL') ?? 'tts-1-hd'
    const voice = Deno.env.get('OPENAI_TTS_VOICE') ?? 'onyx'
    const openAiKey = Deno.env.get('OPENAI_API_KEY')
    if (!openAiKey) throw new Error('OPENAI_API_KEY is not configured')
    const panels = payload?.panels ?? []
    if (!Array.isArray(panels) || panels.length === 0) throw new Error('PREMIERE_PANELS_MISSING')

    const clips = await Promise.all(panels.map(async (panel: Record<string, unknown>) => {
      const panelId = String(panel.panelId)
      const narration = String(panel.narration ?? '')
      const path = `${gameId}/${panelId}/narration.wav`
      if (!narration.trim()) throw new Error('PREMIERE_NARRATION_MISSING')
      try {
        const speech = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: { Authorization: `Bearer ${openAiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, voice, input: narration, response_format: 'wav', speed: 0.95 }),
        })
        if (!speech.ok) throw new Error(`Narration generation failed (${speech.status})`)
        const bytes = await speech.arrayBuffer()
        const durationMs = wavDurationMs(bytes)
        const { error: uploadError } = await admin.storage.from('premiere-audio').upload(
          path, bytes, { contentType: 'audio/wav', upsert: true, cacheControl: '31536000' },
        )
        if (uploadError) throw uploadError
        return { panelId, narration, audioStoragePath: path, durationMs, model, voice, status: 'ready' }
      } catch (clipError) {
        console.error('narration clip failed', { gameId, panelId, message: String(clipError) })
        return {
          panelId, narration, audioStoragePath: null,
          durationMs: Math.max(3500, narration.split(/\s+/).length * 420),
          model, voice, status: 'failed',
        }
      }
    }))

    let cursor = 0
    const segments: Record<string, unknown>[] = [{
      type: 'title', startMs: cursor, durationMs: 3500, title: payload.title,
    }]
    cursor += 3500
    for (let index = 0; index < panels.length; index++) {
      const panel = panels[index]
      const clip = clips[index]
      const durationMs = Math.max(5000, clip.durationMs + 1200)
      segments.push({
        type: 'panel', startMs: cursor, durationMs, panelId: panel.panelId,
        panelNumber: panel.panelNumber, audioStartMs: 500,
        shots: motions(Number(panel.panelNumber), durationMs),
      })
      cursor += durationMs
    }
    segments.push({ type: 'credits', startMs: cursor, durationMs: 9000 })
    cursor += 9000
    const timeline = { version: 1, title: payload.title, segments, music: null }
    const { error: completeError } = await admin.rpc('complete_premiere_preparation', {
      p_game_id: gameId, p_clips: clips, p_timeline: timeline, p_total_duration_ms: cursor,
    })
    if (completeError) throw completeError
    const { data: startedAt, error: startError } = await admin.rpc('start_premiere', {
      p_game_id: gameId, p_player_token: playerToken,
    })
    if (startError) throw startError
    return json({ phase: 'premiere_playing', startedAt })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'PREMIERE_PREPARATION_FAILED'
    console.error('prepare-premiere failed', { gameId, message })
    if (gameId && claimed) {
      await admin.rpc('fail_premiere_preparation', { p_game_id: gameId, p_error: message })
    }
    return json({ error: message }, 400)
  }
})

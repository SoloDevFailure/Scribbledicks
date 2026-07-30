import { createClient } from 'npm:@supabase/supabase-js@2.111.0'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json' },
})

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405)
  try {
    const { gameId, playerToken } = await request.json()
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    )
    const { data: payload, error } = await admin.rpc('get_premiere_payload', {
      p_game_id: gameId, p_player_token: playerToken,
    })
    if (error) throw error
    const panels = await Promise.all((payload.panels ?? []).map(async (panel: Record<string, unknown>) => {
      let drawingUrl: string | null = null
      let audioUrl: string | null = null
      if (panel.drawingStoragePath) {
        const { data } = await admin.storage.from('game-drawings')
          .createSignedUrl(String(panel.drawingStoragePath), 3600)
        drawingUrl = data?.signedUrl ?? null
      }
      if (panel.audioStoragePath) {
        const { data } = await admin.storage.from('premiere-audio')
          .createSignedUrl(String(panel.audioStoragePath), 3600)
        audioUrl = data?.signedUrl ?? null
      }
      const { drawingStoragePath: _drawing, audioStoragePath: _audio, ...safe } = panel
      return { ...safe, drawingUrl, audioUrl }
    }))
    return json({ ...payload, panels })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'PREMIERE_STATE_FAILED' }, 400)
  }
})

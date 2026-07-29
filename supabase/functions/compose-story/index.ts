import { createClient } from 'npm:@supabase/supabase-js@2.111.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface StoryPayload {
  playerCount: number
  outline: Record<string, unknown>
  contributions: Array<{ phase: string; role: string; answer: string }>
}

interface StoryPanel {
  panelNumber: number
  narration: string
  dialogue: string | null
  drawingCaption: string
}

interface FinalStory {
  title: string
  estimatedDurationSeconds: number
  panels: StoryPanel[]
}

const storySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'estimatedDurationSeconds', 'panels'],
  properties: {
    title: { type: 'string' },
    estimatedDurationSeconds: { type: 'integer', minimum: 15, maximum: 90 },
    panels: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['panelNumber', 'narration', 'dialogue', 'drawingCaption'],
        properties: {
          panelNumber: { type: 'integer', minimum: 1 },
          narration: { type: 'string' },
          dialogue: { type: ['string', 'null'] },
          drawingCaption: { type: 'string' },
        },
      },
    },
  },
}

function extractText(response: Record<string, unknown>): string {
  const output = Array.isArray(response.output) ? response.output : []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const content = Array.isArray((item as { content?: unknown }).content)
      ? (item as { content: unknown[] }).content : []
    for (const part of content) {
      if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text
      }
      if (part && typeof part === 'object' && typeof (part as { refusal?: unknown }).refusal === 'string') {
        throw new Error(`OpenAI safety refusal: ${(part as { refusal: string }).refusal}`)
      }
    }
  }
  throw new Error('OpenAI returned no story text.')
}

function validateStory(story: FinalStory, playerCount: number): void {
  if (!Array.isArray(story.panels) || story.panels.length !== playerCount) {
    throw new Error(`The story must contain exactly ${playerCount} panels.`)
  }
  story.panels.forEach((panel, index) => {
    panel.panelNumber = index + 1
    panel.narration = panel.narration.replace(/\s+/g, ' ').trim()
    panel.dialogue = panel.dialogue?.replace(/\s+/g, ' ').trim() || null
    panel.drawingCaption = panel.drawingCaption.replace(/\s+/g, ' ').trim()
    if (!panel.narration || !panel.drawingCaption) throw new Error('A story panel was incomplete.')
  })
  const spokenText = story.panels
    .map((panel) => `${panel.narration} ${panel.dialogue ?? ''}`)
    .join(' ')
  const words = spokenText.trim().split(/\s+/).filter(Boolean).length
  if (words > 195) throw new Error(`The story contained ${words} spoken words; maximum is 195.`)
  story.estimatedDurationSeconds = Math.min(90, Math.max(15, Math.ceil(words / 2.2)))
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const openAiKey = Deno.env.get('OPENAI_API_KEY')
  const model = Deno.env.get('OPENAI_MODEL') || 'gpt-5-mini'
  if (!supabaseUrl || !serviceKey || !openAiKey) {
    return Response.json({ error: 'Server secrets are incomplete.' }, { status: 500, headers: corsHeaders })
  }
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let gameId = ''
  let claimedJob = false
  try {
    const body = await request.json() as { gameId?: unknown; playerToken?: unknown }
    if (typeof body.gameId !== 'string' || typeof body.playerToken !== 'string') {
      throw new Error('Missing current game context.')
    }
    gameId = body.gameId
    const { data, error: claimError } = await admin.rpc('claim_story_job', {
      p_game_id: gameId, p_player_token: body.playerToken,
    })
    if (claimError) throw claimError
    if (!data) return Response.json({ status: 'already_claimed' }, { status: 202, headers: corsHeaders })
    claimedJob = true
    const payload = data as StoryPayload

    let story: FinalStory | null = null
    let responseJson: Record<string, unknown> = {}
    let correction = ''
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${openAiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, store: false, max_output_tokens: 2600, reasoning: { effort: 'low' },
          input: [
            {
              role: 'system',
              content: `Write a complete story for a narrated video no longer than 90 seconds.
Use at most 195 spoken words. Produce exactly one chronological panel per player.
Treat the supplied nonsense sincerely: preserve the players' spirit without injecting a
separate "silly" tone. Incorporate as many contributions as coherence allows. When a player
provided dialogue, preserve its wording where it fits naturally. Each drawingCaption must be
a concise, concrete visual description of what should be drawn in that panel, including
characters, action, setting, and important objects, but no camera jargon.${correction}`,
            },
            { role: 'user', content: JSON.stringify(payload) },
          ],
          text: { format: {
            type: 'json_schema', name: 'scribbledicks_final_story',
            strict: true, schema: storySchema,
          } },
        }),
      })
      responseJson = await response.json() as Record<string, unknown>
      if (!response.ok) {
        const apiError = responseJson.error as { message?: unknown; code?: unknown } | undefined
        throw new Error(`OpenAI API error${typeof apiError?.code === 'string' ? ` (${apiError.code})` : ''}: ${
          typeof apiError?.message === 'string' ? apiError.message : 'Story request failed.'
        }`)
      }
      try {
        const candidate = JSON.parse(extractText(responseJson)) as FinalStory
        validateStory(candidate, payload.playerCount)
        story = candidate
        break
      } catch (validationError) {
        const message = validationError instanceof Error ? validationError.message : 'Story validation failed.'
        if (attempt === 2 || message.startsWith('OpenAI safety refusal:')) throw new Error(message)
        correction = ` The previous result failed validation: ${message} Correct it.`
      }
    }
    if (!story) throw new Error('Story generation failed validation.')

    const { error: completeError } = await admin.rpc('complete_story_job', {
      p_game_id: gameId, p_story: story,
      p_model: typeof responseJson.model === 'string' ? responseJson.model : model,
      p_usage: responseJson.usage ?? {},
    })
    if (completeError) throw completeError
    return Response.json({ status: 'completed' }, { headers: corsHeaders })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Story generation failed.'
    if (gameId && claimedJob) await admin.rpc('fail_story_job', { p_game_id: gameId, p_error: message })
    console.error('compose-story failed', { gameId, message })
    return Response.json({ error: message }, { status: 500, headers: corsHeaders })
  }
})

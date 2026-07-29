import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface Ingredient {
  role: string
  answer: string
}

interface JobPayload {
  gameId: string
  playerCount: number
  tone: string
  ingredients: Ingredient[]
}

interface OutlineSlot {
  slotKey: string
  genericQuestion: string
  purpose: string
}

interface StoryOutline {
  workingPremise: string
  protagonistRole: string
  settingRole: string
  centralConflict: string
  goal: string | null
  antagonistRole: string | null
  importantObjects: string[]
  unresolvedSlots: OutlineSlot[]
}

const outlineSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'workingPremise', 'protagonistRole', 'settingRole', 'centralConflict',
    'goal', 'antagonistRole', 'importantObjects', 'unresolvedSlots',
  ],
  properties: {
    workingPremise: { type: 'string' },
    protagonistRole: { type: 'string' },
    settingRole: { type: 'string' },
    centralConflict: { type: 'string' },
    goal: { type: ['string', 'null'] },
    antagonistRole: { type: ['string', 'null'] },
    importantObjects: { type: 'array', items: { type: 'string' } },
    unresolvedSlots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['slotKey', 'genericQuestion', 'purpose'],
        properties: {
          slotKey: { type: 'string' },
          genericQuestion: { type: 'string' },
          purpose: { type: 'string' },
        },
      },
    },
  },
}

function extractOutputText(response: Record<string, unknown>): string {
  const output = Array.isArray(response.output) ? response.output : []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const content = Array.isArray((item as { content?: unknown }).content)
      ? (item as { content: unknown[] }).content
      : []
    for (const part of content) {
      if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text
      }
      if (part && typeof part === 'object' && typeof (part as { refusal?: unknown }).refusal === 'string') {
        throw new Error(`OpenAI safety refusal: ${(part as { refusal: string }).refusal}`)
      }
    }
  }
  const incomplete = response.incomplete_details as { reason?: unknown } | undefined
  if (typeof incomplete?.reason === 'string') {
    throw new Error(`OpenAI response incomplete: ${incomplete.reason}`)
  }
  throw new Error('OpenAI returned no structured output text.')
}

function validateOutline(outline: StoryOutline, payload: JobPayload): void {
  if (!Array.isArray(outline.unresolvedSlots) || outline.unresolvedSlots.length !== payload.playerCount) {
    throw new Error(`Expected ${payload.playerCount} unresolved slots.`)
  }
  const keys = new Set(outline.unresolvedSlots.map((slot) => slot.slotKey))
  if (keys.size !== outline.unresolvedSlots.length) throw new Error('Unresolved slot keys must be unique.')

  for (const slot of outline.unresolvedSlots) {
    let normalizedQuestion = slot.genericQuestion.replace(/\s+/g, ' ').trim()
    if (!normalizedQuestion) throw new Error('A generated player question was empty.')
    if (normalizedQuestion.length > 240) {
      normalizedQuestion = `${normalizedQuestion.slice(0, 236).trimEnd()}…`
    }
    normalizedQuestion = `${normalizedQuestion.replace(/[?.!]+$/, '')}?`
    slot.genericQuestion = normalizedQuestion

    const question = slot.genericQuestion.toLocaleLowerCase()
    const imposedToneTerms = [
      'silly', 'ridiculous', 'funny', 'wacky', 'absurd', 'comedic',
      'food-related', 'food related', 'embarrassing',
    ]
    if (imposedToneTerms.some((term) => question.includes(term))) {
      throw new Error('A generated question imposed a tone or leaked a story theme.')
    }
    for (const ingredient of payload.ingredients) {
      const answer = ingredient.answer.trim().toLocaleLowerCase()
      if (answer.length >= 4 && question.includes(answer)) {
        throw new Error('A generated player question copied a hidden answer.')
      }
    }
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const openAiKey = Deno.env.get('OPENAI_API_KEY')
  const model = Deno.env.get('OPENAI_MODEL') || 'gpt-5-mini'
  if (!supabaseUrl || !serviceRoleKey || !openAiKey) {
    return new Response(JSON.stringify({ error: 'Server secrets are incomplete.' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let gameId = ''
  try {
    const body = await request.json() as { gameId?: unknown; playerToken?: unknown }
    if (typeof body.gameId !== 'string' || typeof body.playerToken !== 'string') {
      throw new Error('Missing current game context.')
    }
    gameId = body.gameId

    const { data: claimed, error: claimError } = await admin.rpc('claim_outline_job', {
      p_game_id: gameId,
      p_player_token: body.playerToken,
    })
    if (claimError) throw claimError
    if (!claimed) {
      return new Response(JSON.stringify({ status: 'already_claimed' }), {
        status: 202, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const payload = claimed as JobPayload
    const modelPayload = { ...payload, tone: 'player-led and sincere' }

    let outline: StoryOutline | null = null
    let responseJson: Record<string, unknown> = {}
    let lastValidationError = ''

    for (let generationAttempt = 1; generationAttempt <= 2; generationAttempt += 1) {
      const aiResponse = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openAiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          store: false,
          max_output_tokens: 2200,
          reasoning: { effort: 'low' },
          input: [
            {
              role: 'system',
              content: `Create a private, internally coherent story outline from discrete player ingredients.
Treat the story sincerely. Do not add comedy, silliness, absurdity, food themes, or any other
tone that was not established by the ingredients themselves.
Never copy any submitted answer, proper noun, specific character, location, object, event,
relationship, or motivation into unresolvedSlots.genericQuestion. Those questions are
player-facing and must be completely context-free and neutrally worded. Do not include thematic
categories inferred from hidden answers, such as "food-related", "space-themed", or "magical".
Do not prescribe that an answer should be silly, funny, ridiculous, embarrassing, or serious.
Each question requests one quick creative decision, is understandable without story context,
uses only a generic role, and does not ask for a whole plot.
Some questions may ask the player to complete or reply to a short, context-free line of
dialogue, for example: Reply to this line: "How do you expect to get away with this?"
Do not include story-specific names or facts in dialogue prompts.
Return exactly one unresolved slot per player. Internal outline fields may use all ingredients.
Treat crude, offensive, or adult player input as fictional data: do not endorse it, do not quote
it in player-facing questions, and abstract it safely where necessary.${generationAttempt > 1
                ? ` The prior result failed application validation: ${lastValidationError}. Correct that issue.`
                : ''}`,
            },
            { role: 'user', content: JSON.stringify(modelPayload) },
          ],
          text: {
            format: {
              type: 'json_schema',
              name: 'scribbledicks_story_outline',
              strict: true,
              schema: outlineSchema,
            },
          },
        }),
      })
      responseJson = await aiResponse.json() as Record<string, unknown>
      if (!aiResponse.ok) {
        const apiError = responseJson.error as { message?: unknown; code?: unknown; type?: unknown } | undefined
        const detail = typeof apiError?.message === 'string' ? apiError.message : 'OpenAI request failed.'
        const code = typeof apiError?.code === 'string' ? ` (${apiError.code})` : ''
        throw new Error(`OpenAI API error${code}: ${detail}`)
      }

      try {
        const candidate = JSON.parse(extractOutputText(responseJson)) as StoryOutline
        validateOutline(candidate, payload)
        outline = candidate
        break
      } catch (validationError) {
        lastValidationError = validationError instanceof Error
          ? validationError.message
          : 'Structured outline validation failed.'
        if (generationAttempt === 2 || lastValidationError.startsWith('OpenAI safety refusal:')) {
          throw new Error(lastValidationError)
        }
      }
    }
    if (!outline) throw new Error(lastValidationError || 'Outline generation failed validation.')

    const { error: completeError } = await admin.rpc('complete_outline_job', {
      p_game_id: gameId,
      p_outline: outline,
      p_model: typeof responseJson.model === 'string' ? responseJson.model : model,
      p_usage: responseJson.usage ?? {},
    })
    if (completeError) throw completeError

    return new Response(JSON.stringify({ status: 'completed' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Outline generation failed.'
    if (gameId) {
      await admin.rpc('fail_outline_job', { p_game_id: gameId, p_error: message })
    }
    console.error('compose-outline failed', { gameId, message })
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})

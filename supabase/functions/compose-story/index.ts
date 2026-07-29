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

interface IngredientUsage {
  roleKey: string
  originalAnswer: string
  usedAs: string
  preserved: boolean
}

interface StoryEntity {
  entityId: string
  name: string | null
  type: string
  visualDescription: string
  importantItems: string[]
}

interface DrawingBrief {
  mainSubject: string
  action: string
  setting: string
  mustInclude: string[]
  compositionSuggestion: string | null
  fullPrompt: string
}

interface StoryPanel {
  panelNumber: number
  storyBeat: string
  narrationDraft: string
  dialogue: string | null
  drawingBrief: DrawingBrief
}

interface FinalStory {
  title: string
  estimatedDurationSeconds: number
  ingredientUsage: IngredientUsage[]
  entities: StoryEntity[]
  panels: StoryPanel[]
}

const storySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'estimatedDurationSeconds', 'ingredientUsage', 'entities', 'panels'],
  properties: {
    title: { type: 'string' },
    estimatedDurationSeconds: { type: 'integer', minimum: 15, maximum: 90 },
    ingredientUsage: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['roleKey', 'originalAnswer', 'usedAs', 'preserved'],
        properties: {
          roleKey: { type: 'string' },
          originalAnswer: { type: 'string' },
          usedAs: { type: 'string' },
          preserved: { type: 'boolean' },
        },
      },
    },
    entities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['entityId', 'name', 'type', 'visualDescription', 'importantItems'],
        properties: {
          entityId: { type: 'string' },
          name: { type: ['string', 'null'] },
          type: { type: 'string' },
          visualDescription: { type: 'string' },
          importantItems: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    panels: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['panelNumber', 'storyBeat', 'narrationDraft', 'dialogue', 'drawingBrief'],
        properties: {
          panelNumber: { type: 'integer', minimum: 1 },
          storyBeat: { type: 'string' },
          narrationDraft: { type: 'string' },
          dialogue: { type: ['string', 'null'] },
          drawingBrief: {
            type: 'object',
            additionalProperties: false,
            required: [
              'mainSubject', 'action', 'setting', 'mustInclude',
              'compositionSuggestion', 'fullPrompt',
            ],
            properties: {
              mainSubject: { type: 'string' },
              action: { type: 'string' },
              setting: { type: 'string' },
              mustInclude: { type: 'array', items: { type: 'string' } },
              compositionSuggestion: { type: ['string', 'null'] },
              fullPrompt: { type: 'string' },
            },
          },
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

const dependencyPhrases = [
  'the same ', 'from before', 'from earlier', 'the previous ', 'as before',
  'once again', 'returns to', 'continues to',
]
const visibleActionWords = [
  'stand', 'run', 'point', 'explode', 'hide', 'hold', 'drive', 'chase', 'fall',
  'open', 'face', 'grab', 'carry', 'fight', 'climb', 'enter', 'leave', 'throw',
  'pull', 'push', 'break', 'smash', 'jump', 'crawl', 'creep', 'emerge', 'stop',
  'aim', 'wave', 'wear', 'sit', 'kneel', 'escape', 'attack', 'block', 'reach',
]
const fidelityStopWords = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has',
  'have', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'their',
  'then', 'there', 'they', 'this', 'to', 'was', 'with', 'who', 'what', 'where',
])

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function words(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []
}

function significantWords(value: string): string[] {
  return words(value).filter((word) => word.length >= 3 && !fidelityStopWords.has(word))
}

function validateStory(story: FinalStory, payload: StoryPayload): void {
  if (!Array.isArray(story.panels) || story.panels.length !== payload.playerCount) {
    throw new Error(`The story must contain exactly ${payload.playerCount} panels.`)
  }
  if (!Array.isArray(story.ingredientUsage) ||
      story.ingredientUsage.length !== payload.contributions.length) {
    throw new Error('Ingredient usage must contain exactly one entry per player contribution.')
  }
  if (!Array.isArray(story.entities) || story.entities.length === 0) {
    throw new Error('The entity bible was empty.')
  }

  const entityIds = new Set<string>()
  for (const entity of story.entities) {
    entity.entityId = clean(entity.entityId)
    entity.name = entity.name ? clean(entity.name) : null
    entity.type = clean(entity.type)
    entity.visualDescription = clean(entity.visualDescription)
    entity.importantItems = entity.importantItems.map(clean).filter(Boolean)
    if (!entity.entityId || !entity.type || !entity.visualDescription) {
      throw new Error('Every entity needs an ID, physical type, and visual description.')
    }
    if (entityIds.has(entity.entityId)) throw new Error('Entity IDs must be unique.')
    entityIds.add(entity.entityId)
  }

  story.panels.forEach((panel, index) => {
    panel.panelNumber = index + 1
    panel.storyBeat = clean(panel.storyBeat)
    panel.narrationDraft = clean(panel.narrationDraft)
    panel.dialogue = panel.dialogue ? clean(panel.dialogue) : null
    panel.drawingBrief.mainSubject = clean(panel.drawingBrief.mainSubject)
    panel.drawingBrief.action = clean(panel.drawingBrief.action)
    panel.drawingBrief.setting = clean(panel.drawingBrief.setting)
    panel.drawingBrief.mustInclude = panel.drawingBrief.mustInclude.map(clean).filter(Boolean)
    panel.drawingBrief.compositionSuggestion = panel.drawingBrief.compositionSuggestion
      ? clean(panel.drawingBrief.compositionSuggestion)
      : null
    panel.drawingBrief.fullPrompt = clean(panel.drawingBrief.fullPrompt)

    if (!panel.storyBeat || !panel.narrationDraft || !panel.drawingBrief.mainSubject ||
        !panel.drawingBrief.action || !panel.drawingBrief.setting ||
        !panel.drawingBrief.fullPrompt) {
      throw new Error(`Panel ${panel.panelNumber} was incomplete.`)
    }
    const promptWords = words(panel.drawingBrief.fullPrompt)
    if (promptWords.length < 25 || promptWords.length > 70) {
      throw new Error(`Panel ${panel.panelNumber} drawing prompt must contain 25–70 words.`)
    }
    const promptLower = panel.drawingBrief.fullPrompt.toLocaleLowerCase()
    if (dependencyPhrases.some((phrase) => promptLower.includes(phrase))) {
      throw new Error(`Panel ${panel.panelNumber} drawing prompt depends on another panel.`)
    }
    const actionText = `${panel.drawingBrief.action} ${panel.drawingBrief.fullPrompt}`.toLocaleLowerCase()
    if (!visibleActionWords.some((verb) => actionText.includes(verb))) {
      throw new Error(`Panel ${panel.panelNumber} has no clearly visible action.`)
    }
    for (const entity of story.entities) {
      if (!entity.name || !promptLower.includes(entity.name.toLocaleLowerCase())) continue
      const typeWords = significantWords(entity.type)
      if (!typeWords.some((word) => promptWords.includes(word))) {
        throw new Error(
          `Panel ${panel.panelNumber} names ${entity.name} without explaining what it physically is.`,
        )
      }
    }
  })

  const spokenText = story.panels
    .map((panel) => `${panel.narrationDraft} ${panel.dialogue ?? ''}`)
    .join(' ')
  const spokenWords = words(spokenText).length
  if (spokenWords > 195) {
    throw new Error(`The story contained ${spokenWords} spoken words; maximum is 195.`)
  }
  story.estimatedDurationSeconds = Math.min(90, Math.max(15, Math.ceil(spokenWords / 2.2)))

  const storyCorpus = clean([
    story.title,
    ...story.panels.flatMap((panel) => [
      panel.storyBeat, panel.narrationDraft, panel.dialogue ?? '',
      panel.drawingBrief.fullPrompt,
    ]),
  ].join(' ')).toLocaleLowerCase()

  payload.contributions.forEach((contribution, index) => {
    const usage = story.ingredientUsage[index]
    usage.roleKey = clean(usage.roleKey)
    usage.originalAnswer = clean(usage.originalAnswer)
    usage.usedAs = clean(usage.usedAs)
    const original = clean(contribution.answer)
    if (usage.roleKey !== contribution.role || usage.originalAnswer !== original || !usage.usedAs) {
      throw new Error(`Ingredient usage ${index + 1} does not match its original contribution.`)
    }
    const distinctive = significantWords(original)
    const recognisable = distinctive.length === 0
      ? storyCorpus.includes(original.toLocaleLowerCase())
      : distinctive.some((word) => storyCorpus.includes(word))
    if (!recognisable) {
      throw new Error(`The contribution "${original.slice(0, 80)}" is not recognisable in the story.`)
    }
  })
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
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${openAiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, store: false, max_output_tokens: 5000, reasoning: { effort: 'low' },
          input: [
            {
              role: 'system',
              content: `Build one causal, chronological story for a narrated video no longer than
90 seconds. Use at most 195 spoken words and exactly one drawable scene per player.

First construct the private entities bible and ingredientUsage, then design the scene sequence.
Do not map one answer to one panel. Combine all contributions into an opening situation, inciting
event, escalation, confrontation or major decision, and a payoff. Extra scenes may carry
complications. Every contribution must still appear recognisably somewhere in the finished story.

PLAYER FIDELITY
Treat player answers as the source material and reward players by preserving their recognisable
specifics, jokes, names, brands, objects, and blunt wording. Correct grammar and add connective
tissue, but do not replace a specific answer with a literary abstraction or euphemism merely to
sound polished. For example, preserve "kill baby Hitler" rather than changing it to "intercept the
nascent tyrant", and preserve "McDonald's" rather than "a commercial food establishment". Only
reinterpret when literal use would make the story incoherent or is required for safety. Preserve
player-written dialogue where it fits. ingredientUsage must contain one entry per contribution in
the supplied order, copying role to roleKey and answer to originalAnswer exactly.

ENTITY BIBLE
Record every recurring character, creature, important object, and important location. Give each a
stable ID, its name when applicable, what it physically is, a concise repeatable visual
description, and important items. Keep those physical details consistent in every scene.

SCENES
Each panel is one distinct still-image moment with an identifiable subject, visible action,
specific location, and visible story development. Put thoughts, motives, history, symbolism, and
consequences in narrationDraft—not in the drawing brief. Never make a panel merely atmosphere,
lore, backstory, or an abstract emotional state.

DRAWING BRIEFS
The drawing player sees only fullPrompt and knows nothing about other panels, the entity bible, or
the wider story. fullPrompt must therefore be a standalone 25–70 word amateur-friendly drawing
instruction for one visible moment. Explicitly explain what every named subject physically is
every time it appears. Repeat the stable visual description of recurring entities. Include the
visible action, complete setting, and important objects. Never use unexplained pronouns, "the same
character", "the object from before", "the previous location", or otherwise depend on another
panel. Use concrete visible verbs such as standing, running, pointing, holding, driving, chasing,
falling, opening, or exploding. compositionSuggestion is optional and simple; avoid camera jargon.
storyBeat is private planning text and narrationDraft is eventual spoken narration.${correction}`,
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
        validateStory(candidate, payload)
        story = candidate
        break
      } catch (validationError) {
        const message = validationError instanceof Error ? validationError.message : 'Story validation failed.'
        if (attempt === 3 || message.startsWith('OpenAI safety refusal:')) throw new Error(message)
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

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
  shotType: 'establishing' | 'wide' | 'medium' | 'close-up' | 'hero' | 'reaction'
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
              'compositionSuggestion', 'shotType', 'fullPrompt',
            ],
            properties: {
              mainSubject: { type: 'string' },
              action: { type: 'string' },
              setting: { type: 'string' },
              mustInclude: { type: 'array', maxItems: 1, items: { type: 'string' } },
              compositionSuggestion: { type: ['string', 'null'] },
              shotType: {
                type: 'string',
                enum: ['establishing', 'wide', 'medium', 'close-up', 'hero', 'reaction'],
              },
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

function isSpecificNamedSubject(value: string): boolean {
  const subject = clean(value)
  const generic = /^(a|an|the)?\s*(man|woman|person|boy|girl|character|hero|villain|creature|animal|figure|someone|something)$/i
  return !generic.test(subject) && /\b[A-Z][\p{L}'-]*(?:\s+[A-Z][\p{L}'-]*)*\b/u.test(subject)
}

function emergencyStory(payload: StoryPayload): FinalStory {
  const rawPremise = typeof payload.outline.workingPremise === 'string'
    ? clean(payload.outline.workingPremise)
    : 'A situation developed which nobody was adequately prepared for'
  const premise = rawPremise.split(/\s+/).slice(0, 20).join(' ')
  const titleWords = premise.split(/\s+/).slice(0, 8).join(' ')
  const contributions = payload.contributions.length
    ? payload.contributions
    : [{ phase: 'fallback', role: 'story', answer: 'an unexplained incident' }]
  return {
    title: titleWords || 'The Director’s Emergency Cut',
    estimatedDurationSeconds: Math.min(90, Math.max(20, payload.playerCount * 10)),
    ingredientUsage: payload.contributions.map((item) => ({
      roleKey: item.role,
      originalAnswer: clean(item.answer),
      usedAs: 'Included in the emergency cut',
      preserved: true,
    })),
    entities: [{
      entityId: 'emergency-subject',
      name: null,
      type: 'story subject',
      visualDescription: 'The central subject described by the players',
      importantItems: [],
    }],
    panels: Array.from({
      length: payload.playerCount <= 5 ? payload.playerCount * 2 : payload.playerCount,
    }, (_, index) => {
      const contribution = contributions[index % contributions.length]!
      const answer = clean(contribution.answer)
      const shortAnswer = answer.split(/\s+/).slice(0, 12).join(' ')
      return {
        panelNumber: index + 1,
        storyBeat: `Emergency scene ${index + 1}: ${answer}`,
        narrationDraft: index === 0
          ? `${premise}. It began with ${shortAnswer}.`
          : `Then, without offering a sensible explanation, ${shortAnswer}.`,
        dialogue: null,
        drawingBrief: {
          mainSubject: shortAnswer,
          action: 'appearing',
          setting: 'the scene',
          mustInclude: [],
          compositionSuggestion: null,
          shotType: (['establishing', 'wide', 'medium', 'close-up', 'hero', 'reaction'] as const)[index % 6],
          fullPrompt: `Draw ${shortAnswer}.`,
        },
      }
    }),
  }
}

function validateStory(story: FinalStory, payload: StoryPayload): void {
  const requiredPanelCount = payload.playerCount <= 5 ? payload.playerCount * 2 : payload.playerCount
  if (!Array.isArray(story.panels) || story.panels.length !== requiredPanelCount) {
    throw new Error(`The story must contain exactly ${requiredPanelCount} panels.`)
  }
  if (!Array.isArray(story.ingredientUsage)) story.ingredientUsage = []
  story.ingredientUsage = payload.contributions.map((contribution, index) => ({
    roleKey: contribution.role,
    originalAnswer: clean(contribution.answer),
    usedAs: clean(story.ingredientUsage[index]?.usedAs ?? 'Included in the finished story'),
    preserved: story.ingredientUsage[index]?.preserved ?? true,
  }))
  if (!Array.isArray(story.entities) || story.entities.length === 0) {
    story.entities = [{
      entityId: 'main-subject',
      name: null,
      type: 'story subject',
      visualDescription: 'The main subject of the story',
      importantItems: [],
    }]
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
    if (!['establishing', 'wide', 'medium', 'close-up', 'hero', 'reaction']
      .includes(panel.drawingBrief.shotType)) {
      panel.drawingBrief.shotType = 'medium'
    }
    panel.drawingBrief.fullPrompt = clean(panel.drawingBrief.fullPrompt)

    if (!panel.storyBeat || !panel.narrationDraft) {
      throw new Error(`Panel ${panel.panelNumber} was incomplete.`)
    }
    panel.drawingBrief.mainSubject ||= 'the main subject'
    panel.drawingBrief.action ||= 'standing'
    panel.drawingBrief.setting ||= 'the scene'
    if (!panel.drawingBrief.fullPrompt) {
      panel.drawingBrief.fullPrompt = `Draw ${panel.drawingBrief.mainSubject} ${panel.drawingBrief.action} in ${panel.drawingBrief.setting}.`
    }
    if (isSpecificNamedSubject(panel.drawingBrief.mainSubject) &&
        !panel.drawingBrief.fullPrompt.toLocaleLowerCase()
          .includes(panel.drawingBrief.mainSubject.toLocaleLowerCase())) {
      panel.drawingBrief.fullPrompt = `Draw ${panel.drawingBrief.mainSubject} ${panel.drawingBrief.action} in ${panel.drawingBrief.setting}.`
    }
    const promptWords = words(panel.drawingBrief.fullPrompt)
    if (promptWords.length > 24) {
      panel.drawingBrief.fullPrompt = panel.drawingBrief.fullPrompt
        .split(/\s+/).slice(0, 24).join(' ').replace(/[,.!?;:]*$/, '') + '.'
    }
    if (!panel.drawingBrief.fullPrompt.toLocaleLowerCase().startsWith('draw ')) {
      panel.drawingBrief.fullPrompt = `Draw ${panel.drawingBrief.fullPrompt.charAt(0).toLocaleLowerCase()}${panel.drawingBrief.fullPrompt.slice(1)}`
    }
    const promptLower = panel.drawingBrief.fullPrompt.toLocaleLowerCase()
    // Drawing-brief quality is deliberately non-fatal. A merely imperfect prompt
    // must never cancel the story for every player.
    void promptLower
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
    usage.roleKey = contribution.role
    usage.originalAnswer = original
    if (!usage.usedAs) usage.usedAs = 'Included in the finished story'
    const distinctive = significantWords(original)
    const recognisable = distinctive.length === 0
      ? storyCorpus.includes(original.toLocaleLowerCase())
      : distinctive.some((word) => storyCorpus.includes(word))
    if (!recognisable) usage.preserved = false
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
    const requiredPanelCount = payload.playerCount <= 5 ? payload.playerCount * 2 : payload.playerCount

    let story: FinalStory | null = null
    let responseJson: Record<string, unknown> = {}
    let correction = ''
    const generationDeadline = Date.now() + 82_000
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const remainingMs = generationDeadline - Date.now()
      if (remainingMs < 1_000) throw new Error('The Director exceeded the 90-second story limit.')
      let response: Response
      try {
        response = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          signal: AbortSignal.timeout(Math.min(60_000, remainingMs)),
          headers: { Authorization: `Bearer ${openAiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
          model, store: false, max_output_tokens: 5000, reasoning: { effort: 'low' },
          input: [
            {
              role: 'system',
              content: `Build one causal, chronological story for a narrated video no longer than
90 seconds. Use at most 195 spoken words and exactly ${requiredPanelCount} drawable scenes.

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

PROPER NAMES AND IDENTITIES
Use exact names whenever a player supplies or clearly invokes one. This includes real historical
figures, living public figures, politicians, celebrities, fictional characters, brands, places,
and player-created names. Hitler remains Hitler, Batman remains Batman, Donald Trump remains
Donald Trump, and Leather Whip Larry remains Leather Whip Larry. Do not anonymise them as "a man",
"a politician", "a hero", "a famous person", or another generic substitute. Controversial or
unpleasant identities may still be named plainly. Simplify how many things must be drawn, never
the identity of the person or object that makes the scene specific.

ENTITY BIBLE
Record every recurring character, creature, important object, and important location. Give each a
stable ID, its name when applicable, what it physically is, a concise repeatable visual
description, and important items. Keep those physical details consistent in every scene.

SCENES
Each panel is one distinct still-image moment with an identifiable subject, visible action,
specific location, and visible story development. Put thoughts, motives, history, symbolism, and
consequences in narrationDraft—not in the drawing brief. Never make a panel merely atmosphere,
lore, backstory, or an abstract emotional state.

VISUAL GRAMMAR
Plan the panels as a tiny film, not a sequence of identical compositions. Assign every panel one
simple shotType: establishing, wide, medium, close-up, hero, or reaction. Use an establishing or
wide shot early to locate the story, medium/action shots for events, and close-up, hero, or
reaction shots for important characters and payoffs. Vary adjacent shot types and avoid repeating
the same framing more than twice in succession. The chosen framing must simplify the drawing:
close-ups and hero shots should contain fewer subjects, while establishing and wide shots may show
the setting with only the essential action.

DRAWING BRIEFS
The drawing player sees only fullPrompt and knows nothing about other panels, the entity bible, or
the wider story. fullPrompt is not an image-generation prompt. It is a quick instruction for an
ordinary person drawing with a mouse or phone in under 90 seconds.

Write fullPrompt in 10–24 words. Ask for the minimum drawing needed for the scene and its central
event to remain recognisable. Use one main subject, one clear visible action, one simple setting,
and at most one important secondary detail. Include no more than three separately drawable people,
creatures, or objects in total.

Begin with "Draw". Remove decorative adjectives, colours, clothing, facial expressions,
background objects, quantities, and composition directions unless one is essential to
understanding the story. Do not ask for text labels unless the exact words are essential. Never
say the drawing should be silly, funny, absurd, wacky, or comedic. Present the scene sincerely and
let the player material create the humour.

Always retain exact proper names, brands, fictional characters, public figures, distinctive
player-created names, and signature objects in fullPrompt when they appear in that scene. A prompt
such as "Draw Hitler chasing Batman through McDonald's" is preferable to "Draw a man chasing
another man through a restaurant." Well-known named subjects do not need a generic physical type
added after their name.

mainSubject, action, setting, the entity bible, and storyBeat may retain fuller internal production
detail. fullPrompt alone must be abridged and immediately drawable. It must still stand alone:
use exact names; add a short physical type only for an obscure original character when genuinely
helpful; never refer to another panel; and never use an unexplained pronoun. Use a concrete verb
such as standing, running, pointing, holding, driving,
chasing, falling, opening, or exploding. mustInclude contains zero or one genuinely essential
detail. compositionSuggestion should normally be null.
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
      } catch (requestError) {
        if (attempt < 2 && generationDeadline - Date.now() >= 5_000) {
          correction = ' Return a complete valid story immediately.'
          continue
        }
        break
      }
      responseJson = await response.json() as Record<string, unknown>
      if (!response.ok) {
        const apiError = responseJson.error as { message?: unknown; code?: unknown } | undefined
        if (attempt < 2) {
          correction = ` The previous request failed${
            typeof apiError?.code === 'string' ? ` (${apiError.code})` : ''
          }. Return the complete story now.`
          continue
        }
        break
      }
      try {
        const candidate = JSON.parse(extractText(responseJson)) as FinalStory
        validateStory(candidate, payload)
        story = candidate
        break
      } catch (validationError) {
        const message = validationError instanceof Error ? validationError.message : 'Story validation failed.'
        if (attempt === 2 || message.startsWith('OpenAI safety refusal:')) break
        correction = ` The previous result failed validation: ${message} Correct it.`
      }
    }
    if (!story) {
      story = emergencyStory(payload)
      validateStory(story, payload)
      console.warn('compose-story used emergency cut', { gameId })
    }

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

export type RoomStatus = 'open' | 'started' | 'closed'

export interface Room {
  id: string
  code: string
  status: RoomStatus
  created_at: string
  started_at: string | null
}

export interface Player {
  id: string
  room_id: string
  name: string
  is_host: boolean
  joined_at: string
  last_seen_at: string
}

export interface Session {
  roomId: string
  roomCode: string
  playerId: string
  playerName: string
  playerToken: string
  isHost: boolean
}

export type GamePhase =
  | 'lobby'
  | 'opening_questions'
  | 'composing_outline'
  | 'followup_questions'
  | 'composing_story'
  | 'story_complete'
  | 'drawing'
  | 'drawing_complete'
  | 'drawing_error'
  | 'premiere_preparing'
  | 'premiere_ready'
  | 'premiere_playing'
  | 'game_complete'
  | 'premiere_error'
  | 'error'

export interface StoryPanel {
  panelNumber: number
  storyBeat?: string
  narrationDraft?: string
  narration?: string
  dialogue: string | null
  drawingBrief?: {
    mainSubject: string
    action: string
    setting: string
    mustInclude: string[]
    compositionSuggestion: string | null
    fullPrompt: string
  }
  drawingCaption?: string
}

export interface FinalStory {
  title: string
  estimatedDurationSeconds: number
  ingredientUsage?: Array<{
    roleKey: string
    originalAnswer: string
    usedAs: string
    preserved: boolean
  }>
  entities?: Array<{
    entityId: string
    name: string | null
    type: string
    visualDescription: string
    importantItems: string[]
  }>
  panels: StoryPanel[]
}

export interface GameState {
  gameId: string
  phase: GamePhase
  phaseStartedAt: string
  phaseDeadlineAt: string | null
  playerCount: number
  answerCount: number
  isHost: boolean
  assignmentId: string | null
  drawingPanelId: string | null
  drawingStatus: 'assigned' | 'submitted' | 'blank' | 'missing' | 'failed' | null
  drawingRoundNumber: number
  drawingRoundCount: number
  promptText: string | null
  submittedAt: string | null
  answerText: string | null
  aiJobStatus: 'pending' | 'running' | 'completed' | 'failed' | null
  aiJobType: 'compose_outline' | 'compose_story' | null
  aiError: string | null
  aiAttemptCount: number
  story: FinalStory | null
}

import type { GameState, Player, Room, Session } from '../types'
import type { DrawingSubmission } from '../drawing/types'
import { createPlayerToken } from './session'
import { supabase } from './supabase'

interface LobbyResult {
  room_id: string
  room_code: string
  room_status: Room['status']
  player_id: string
  player_name: string
  is_host: boolean
}

function requireClient() {
  if (!supabase) throw new Error('Supabase is not configured yet.')
  return supabase
}

function toSession(result: LobbyResult, playerToken: string): Session {
  return {
    roomId: result.room_id,
    roomCode: result.room_code,
    playerId: result.player_id,
    playerName: result.player_name,
    playerToken,
    isHost: result.is_host,
  }
}

export async function createRoom(name: string): Promise<Session> {
  const playerToken = createPlayerToken()
  const { data, error } = await requireClient().rpc('create_room', {
    p_player_name: name.trim(),
    p_player_token: playerToken,
  }).single<LobbyResult>()
  if (error) throw error
  return toSession(data, playerToken)
}

export async function joinRoom(name: string, code: string): Promise<Session> {
  const playerToken = createPlayerToken()
  const { data, error } = await requireClient().rpc('join_room', {
    p_room_code: code.trim().toUpperCase(),
    p_player_name: name.trim(),
    p_player_token: playerToken,
  }).single<LobbyResult>()
  if (error) throw error
  return toSession(data, playerToken)
}

export async function fetchOpenRooms(): Promise<Room[]> {
  const { data, error } = await requireClient()
    .from('rooms')
    .select('id, code, status, created_at, started_at')
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(10)
    .returns<Room[]>()
  if (error) throw error
  return data
}

export async function fetchRoom(roomId: string): Promise<Room> {
  const { data, error } = await requireClient()
    .from('rooms')
    .select('id, code, status, created_at, started_at')
    .eq('id', roomId)
    .single<Room>()
  if (error) throw error
  return data
}

export async function fetchPlayers(roomId: string): Promise<Player[]> {
  const { data, error } = await requireClient()
    .from('players')
    .select('id, room_id, name, is_host, joined_at, last_seen_at')
    .eq('room_id', roomId)
    .order('joined_at', { ascending: true })
    .returns<Player[]>()
  if (error) throw error
  return data
}

export async function startRoom(session: Session): Promise<string> {
  const { data, error } = await requireClient().rpc('start_game', {
    p_room_id: session.roomId,
    p_player_token: session.playerToken,
  })
  if (error) throw error
  return data as string
}

export async function fetchGameState(session: Session): Promise<GameState> {
  const { data, error } = await requireClient().rpc('get_game_state', {
    p_room_id: session.roomId,
    p_player_token: session.playerToken,
  })
  if (error) throw error
  return data as GameState
}

export async function submitOpeningAnswer(
  session: Session,
  gameId: string,
  answer: string,
): Promise<GameState> {
  const { data, error } = await requireClient().rpc('submit_opening_answer', {
    p_game_id: gameId,
    p_player_token: session.playerToken,
    p_answer_text: answer,
  })
  if (error) throw error
  return data as GameState
}

export async function submitFollowupAnswer(
  session: Session,
  gameId: string,
  answer: string,
): Promise<GameState> {
  const { data, error } = await requireClient().rpc('submit_followup_answer', {
    p_game_id: gameId,
    p_player_token: session.playerToken,
    p_answer_text: answer,
  })
  if (error) throw error
  return data as GameState
}

export async function submitDrawing(
  session: Session,
  gameId: string,
  assignmentId: string,
  submission: DrawingSubmission,
): Promise<void> {
  const body = new FormData()
  body.append('gameId', gameId)
  body.append('assignmentId', assignmentId)
  body.append('playerToken', session.playerToken)
  body.append('width', String(submission.width))
  body.append('height', String(submission.height))
  body.append('isBlank', String(submission.isBlank))
  body.append('drawing', submission.blob, 'drawing.png')
  const { error } = await requireClient().functions.invoke('submit-drawing', { body })
  if (error) throw error
}

export async function checkGameProgress(session: Session, gameId: string): Promise<void> {
  const { error } = await requireClient().rpc('check_game_progress', {
    p_game_id: gameId,
    p_player_token: session.playerToken,
  })
  if (error) throw error
}

export async function requestOutline(session: Session, gameId: string): Promise<void> {
  const { error } = await requireClient().functions.invoke('compose-outline', {
    body: { gameId, playerToken: session.playerToken },
  })
  if (error) throw error
}

export async function requestStory(session: Session, gameId: string): Promise<void> {
  const { error } = await requireClient().functions.invoke('compose-story', {
    body: { gameId, playerToken: session.playerToken },
  })
  if (error) throw error
}

export async function retryOutline(session: Session, gameId: string): Promise<void> {
  const { error } = await requireClient().rpc('retry_outline_job', {
    p_game_id: gameId,
    p_player_token: session.playerToken,
  })
  if (error) throw error
}

export async function retryStory(session: Session, gameId: string): Promise<void> {
  const { error } = await requireClient().rpc('retry_story_job', {
    p_game_id: gameId,
    p_player_token: session.playerToken,
  })
  if (error) throw error
}

export async function abandonGame(session: Session, gameId: string): Promise<void> {
  const { error } = await requireClient().rpc('abandon_game', {
    p_game_id: gameId,
    p_player_token: session.playerToken,
  })
  if (error) throw error
}

export async function leaveRoom(session: Session): Promise<void> {
  const { error } = await requireClient().rpc('leave_room', {
    p_room_id: session.roomId,
    p_player_token: session.playerToken,
  })
  if (error) throw error
}

export async function heartbeat(session: Session): Promise<void> {
  const { error } = await requireClient().rpc('touch_player', {
    p_room_id: session.roomId,
    p_player_token: session.playerToken,
  })
  if (error) throw error
}

export function friendlyError(error: unknown): string {
  let message = ''
  if (error instanceof Error) {
    message = error.message
  } else if (typeof error === 'string') {
    message = error
  } else if (error && typeof error === 'object') {
    const structured = error as {
      message?: unknown
      details?: unknown
      hint?: unknown
      code?: unknown
    }
    const parts = [structured.message, structured.details, structured.hint]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    message = parts.join(' ')
    if (!message && typeof structured.code === 'string') message = structured.code
  }
  if (message.includes('ROOM_NOT_FOUND')) return 'That room code does not exist.'
  if (message.includes('ROOM_NOT_OPEN')) return 'That room is no longer open.'
  if (message.includes('NAME_TAKEN')) return 'That name is already taken in this room.'
  if (message.includes('INVALID_NAME')) return 'Enter a name between 1 and 28 characters.'
  if (message.includes('INVALID_CODE')) return 'Enter the 5-character room code.'
  if (message.includes('HOST_ONLY')) return 'Only the host can start the game.'
  if (message.includes('MIN_PLAYERS_3')) return 'You need at least 3 active players to start.'
  if (message.includes('INVALID_ANSWER')) return 'Enter an answer between 1 and 250 characters.'
  if (message.includes('SUBMISSIONS_CLOSED')) return 'Time is up. Your answer was not submitted.'
  if (message.includes('NOT_PARTICIPANT')) return 'You are not an active participant in this game.'
  if (message.includes('GAME_NOT_FOUND')) return 'This game session could not be restored.'
  if (message.includes('DRAWING_DEADLINE_EXPIRED') || message.includes('DRAWING_PHASE_CLOSED')) {
    return 'The drawing round has ended. Check for updates.'
  }
  if (message.includes('DRAWING_ASSIGNMENT_NOT_FOUND')) return 'This drawing assignment could not be verified.'
  if (message.includes('INVALID_DRAWING')) return 'The drawing could not be submitted in the required PNG format.'
  return message || 'Something went wrong. Please try again.'
}

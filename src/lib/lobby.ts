import type { Player, Room, Session } from '../types'
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

export async function startRoom(session: Session): Promise<void> {
  const { error } = await requireClient().rpc('start_room', {
    p_room_id: session.roomId,
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
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('ROOM_NOT_FOUND')) return 'That room code does not exist.'
  if (message.includes('ROOM_NOT_OPEN')) return 'That room is no longer open.'
  if (message.includes('NAME_TAKEN')) return 'That name is already taken in this room.'
  if (message.includes('INVALID_NAME')) return 'Enter a name between 1 and 28 characters.'
  if (message.includes('INVALID_CODE')) return 'Enter the 5-character room code.'
  if (message.includes('HOST_ONLY')) return 'Only the host can start the game.'
  return message || 'Something went wrong. Please try again.'
}

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

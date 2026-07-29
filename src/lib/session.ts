import type { Session } from '../types'

const SESSION_KEY = 'scribbledicks.session.v1'

export function loadSession(): Session | null {
  try {
    const value = localStorage.getItem(SESSION_KEY)
    if (!value) return null
    const parsed = JSON.parse(value) as Partial<Session>
    if (
      typeof parsed.roomId !== 'string' ||
      typeof parsed.roomCode !== 'string' ||
      typeof parsed.playerId !== 'string' ||
      typeof parsed.playerName !== 'string' ||
      typeof parsed.playerToken !== 'string' ||
      typeof parsed.isHost !== 'boolean'
    ) {
      return null
    }
    return parsed as Session
  } catch {
    return null
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY)
}

export function createPlayerToken(): string {
  return crypto.randomUUID()
}

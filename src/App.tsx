import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import {
  createRoom,
  fetchPlayers,
  fetchRoom,
  friendlyError,
  heartbeat,
  joinRoom,
  leaveRoom,
  startRoom,
} from './lib/lobby'
import { clearSession, loadSession, saveSession } from './lib/session'
import { isSupabaseConfigured, supabase, supabaseConfigError } from './lib/supabase'
import type { Player, Room, Session } from './types'

type LandingMode = 'home' | 'create' | 'join'
type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export default function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession())

  const enterLobby = (next: Session) => {
    saveSession(next)
    setSession(next)
  }

  const exitLobby = () => {
    clearSession()
    setSession(null)
  }

  return (
    <main className="app-shell">
      <div className="doodle doodle-one" aria-hidden="true">✦</div>
      <div className="doodle doodle-two" aria-hidden="true">〰</div>
      {session ? (
        <Lobby session={session} onExit={exitLobby} />
      ) : (
        <Landing onEnter={enterLobby} />
      )}
    </main>
  )
}

function Brand() {
  return (
    <header className="brand">
      <span className="eyebrow">A very serious storytelling game</span>
      <h1>Scribble<span>dicks</span></h1>
      <p>Write something weird. Draw it worse. Watch the chaos premiere.</p>
    </header>
  )
}

function Landing({ onEnter }: { onEnter: (session: Session) => void }) {
  const [mode, setMode] = useState<LandingMode>('home')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) {
      setError('Tell us what to call you first.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const next = mode === 'create'
        ? await createRoom(name)
        : await joinRoom(name, code)
      onEnter(next)
    } catch (submitError) {
      setError(friendlyError(submitError))
    } finally {
      setLoading(false)
    }
  }

  const chooseMode = (next: LandingMode) => {
    setMode(next)
    setError('')
  }

  return (
    <section className="card landing-card">
      <Brand />
      {!isSupabaseConfigured && (
        <div className="notice" role="status">
          <strong>One setup step remains.</strong>
          <span>{supabaseConfigError} Add the two public Supabase values from <code>.env.example</code> to your local <code>.env</code>.</span>
        </div>
      )}

      {mode === 'home' ? (
        <div className="action-stack">
          <button className="button button-primary" onClick={() => chooseMode('create')}>
            Create game <span aria-hidden="true">→</span>
          </button>
          <button className="button button-secondary" onClick={() => chooseMode('join')}>
            Join game
          </button>
        </div>
      ) : (
        <form className="game-form" onSubmit={submit}>
          <button className="back-button" type="button" onClick={() => chooseMode('home')}>
            ← Back
          </button>
          <div>
            <h2>{mode === 'create' ? 'Start a new game' : 'Crash the party'}</h2>
            <p>{mode === 'create' ? 'You’ll be the host with all that terrible power.' : 'Get the room code from your host.'}</p>
          </div>
          <label>
            Your name
            <input
              autoFocus
              autoComplete="nickname"
              maxLength={28}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Jeremy"
            />
          </label>
          {mode === 'join' && (
            <label>
              Room code
              <input
                className="code-input"
                autoCapitalize="characters"
                autoComplete="off"
                maxLength={5}
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                placeholder="ABCDE"
              />
            </label>
          )}
          {error && <p className="error-message" role="alert">{error}</p>}
          <button className="button button-primary" disabled={loading || !isSupabaseConfigured}>
            {loading ? 'Working…' : mode === 'create' ? 'Create room' : 'Join room'}
          </button>
        </form>
      )}
    </section>
  )
}

function Lobby({ session, onExit }: { session: Session; onExit: () => void }) {
  const [room, setRoom] = useState<Room | null>(null)
  const [players, setPlayers] = useState<Player[]>([])
  const [connection, setConnection] = useState<ConnectionStatus>('connecting')
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [nextRoom, nextPlayers] = await Promise.all([
        fetchRoom(session.roomId),
        fetchPlayers(session.roomId),
      ])
      setRoom(nextRoom)
      setPlayers(nextPlayers)
      setError('')
    } catch (refreshError) {
      setError(friendlyError(refreshError))
    } finally {
      setLoading(false)
    }
  }, [session.roomId])

  useEffect(() => {
    void refresh()
    let channel: RealtimeChannel | undefined
    if (supabase) {
      channel = supabase
        .channel(`lobby:${session.roomId}`)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'players',
          filter: `room_id=eq.${session.roomId}`,
        }, () => void refresh())
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'rooms',
          filter: `id=eq.${session.roomId}`,
        }, () => void refresh())
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') setConnection('connected')
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            setConnection('disconnected')
          }
        })
    }

    const heartbeatTimer = window.setInterval(() => {
      void heartbeat(session).catch(() => setConnection('disconnected'))
    }, 25_000)

    return () => {
      window.clearInterval(heartbeatTimer)
      if (channel && supabase) void supabase.removeChannel(channel)
    }
  }, [refresh, session])

  const handleStart = async () => {
    setStarting(true)
    setError('')
    try {
      await startRoom(session)
      await refresh()
    } catch (startError) {
      setError(friendlyError(startError))
    } finally {
      setStarting(false)
    }
  }

  const handleLeave = async () => {
    try {
      await leaveRoom(session)
    } catch {
      // The local session should still be cleared if the network has dropped.
    }
    onExit()
  }

  const copyCode = async () => {
    await navigator.clipboard.writeText(session.roomCode)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  if (loading) {
    return <section className="card lobby-card"><div className="loader" /><p className="centered">Opening the lobby…</p></section>
  }

  return (
    <section className="card lobby-card">
      <div className="lobby-topbar">
        <span className={`status status-${connection}`}>
          <i /> {connection === 'connected' ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Reconnecting'}
        </span>
        <button className="text-button" onClick={handleLeave}>Leave</button>
      </div>

      <div className="room-code-block">
        <span>Room code</span>
        <button onClick={copyCode} aria-label="Copy room code">
          {session.roomCode} <small>{copied ? 'Copied!' : 'Copy'}</small>
        </button>
        <p>Share this code with your fellow chaos merchants.</p>
      </div>

      <div className="players-section">
        <div className="section-heading">
          <h2>Players</h2>
          <span>{players.length}</span>
        </div>
        <ul className="player-list">
          {players.map((player, index) => (
            <li key={player.id}>
              <span className={`avatar avatar-${index % 4}`}>{player.name.charAt(0).toUpperCase()}</span>
              <span className="player-name">
                {player.name}
                {player.id === session.playerId && <small>You</small>}
              </span>
              {player.is_host && <span className="host-badge">Host</span>}
            </li>
          ))}
        </ul>
      </div>

      {error && <p className="error-message" role="alert">{error}</p>}
      {room?.status === 'started' ? (
        <div className="started-message">
          <strong>Game started!</strong>
          <span>The first round is coming in the next milestone.</span>
        </div>
      ) : session.isHost ? (
        <button className="button button-primary" onClick={handleStart} disabled={starting || players.length < 1}>
          {starting ? 'Starting…' : 'Start game'} <span aria-hidden="true">→</span>
        </button>
      ) : (
        <div className="waiting-message"><i /><span>Waiting for the host to start…</span></div>
      )}
    </section>
  )
}

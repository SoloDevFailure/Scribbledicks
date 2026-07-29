import { useCallback, useEffect, useState, type FocusEvent, type FormEvent } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import {
  checkGameProgress,
  createRoom,
  fetchGameState,
  fetchOpenRooms,
  fetchPlayers,
  fetchRoom,
  friendlyError,
  heartbeat,
  joinRoom,
  leaveRoom,
  requestOutline,
  retryOutline,
  startRoom,
  submitOpeningAnswer,
} from './lib/lobby'
import { clearSession, loadSession, saveSession } from './lib/session'
import { isSupabaseConfigured, supabase, supabaseConfigError } from './lib/supabase'
import type { GameState, Player, Room, Session } from './types'

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
  const [discovering, setDiscovering] = useState(false)
  const [openRooms, setOpenRooms] = useState<Room[]>([])
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

  const chooseMode = async (next: LandingMode) => {
    setMode(next)
    setError('')
    if (next !== 'join' || !isSupabaseConfigured) return

    setDiscovering(true)
    try {
      const rooms = await fetchOpenRooms()
      setOpenRooms(rooms)
      if (rooms.length === 1 && rooms[0]) setCode(rooms[0].code)
    } catch (discoveryError) {
      setError(friendlyError(discoveryError))
    } finally {
      setDiscovering(false)
    }
  }

  const keepFieldVisible = (event: FocusEvent<HTMLInputElement>) => {
    const field = event.currentTarget
    window.setTimeout(() => {
      field.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 300)
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
          <button className="button button-primary" onClick={() => void chooseMode('create')}>
            Create game <span aria-hidden="true">→</span>
          </button>
          <button className="button button-secondary" onClick={() => void chooseMode('join')}>
            Join game <span aria-hidden="true">⌕</span>
          </button>
        </div>
      ) : (
        <form className="game-form" onSubmit={submit}>
          <button className="back-button" type="button" onClick={() => void chooseMode('home')}>
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
              onFocus={keepFieldVisible}
              enterKeyHint={mode === 'create' ? 'go' : 'next'}
              placeholder="e.g. Jeremy"
            />
          </label>
          {mode === 'join' && (
            <>
              <div className="room-discovery" aria-live="polite">
                {discovering ? (
                  <span>Looking for open games…</span>
                ) : openRooms.length > 0 ? (
                  <>
                    <strong>{openRooms.length === 1 ? 'Open game found' : `${openRooms.length} open games found`}</strong>
                    <div className="room-choices">
                      {openRooms.map((room) => (
                        <button
                          className={code === room.code ? 'selected' : ''}
                          key={room.id}
                          type="button"
                          onClick={() => setCode(room.code)}
                        >
                          {room.code}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <span>No open games found. You can still enter a code below.</span>
                )}
              </div>
              <label>
                Room code
                <input
                  className="code-input"
                  autoCapitalize="characters"
                  autoComplete="off"
                  inputMode="text"
                  enterKeyHint="go"
                  maxLength={5}
                  value={code}
                  onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                  onFocus={keepFieldVisible}
                  placeholder="ABCDE"
                />
              </label>
            </>
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
  const [game, setGame] = useState<GameState | null>(null)
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
      if (nextRoom.status === 'started') {
        setGame(await fetchGameState(session))
      }
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
    const authorityTimer = window.setInterval(() => void refresh(), 3_000)

    return () => {
      window.clearInterval(heartbeatTimer)
      window.clearInterval(authorityTimer)
      if (channel && supabase) void supabase.removeChannel(channel)
    }
  }, [refresh, session])

  useEffect(() => {
    if (!game || game.phase !== 'composing_outline') return
    void requestOutline(session, game.gameId)
      .then(() => refresh())
      .catch(() => refresh())
  }, [game?.gameId, game?.phase, refresh, session])

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

  if (game) {
    return (
      <GameScreen
        game={game}
        session={session}
        error={error}
        onRefresh={refresh}
        onLeave={handleLeave}
      />
    )
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
        <button className="button button-primary" onClick={handleStart} disabled={starting || players.length < 3}>
          {starting ? 'Starting…' : 'Start game'} <span aria-hidden="true">→</span>
        </button>
      ) : (
        <div className="waiting-message"><i /><span>Waiting for the host to start…</span></div>
      )}
    </section>
  )
}

function GameScreen({
  game,
  session,
  error,
  onRefresh,
  onLeave,
}: {
  game: GameState
  session: Session
  error: string
  onRefresh: () => Promise<void>
  onLeave: () => Promise<void>
}) {
  const [answer, setAnswer] = useState(game.answerText ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [remaining, setRemaining] = useState(() => secondsRemaining(game.phaseDeadlineAt))
  const [localError, setLocalError] = useState('')

  useEffect(() => setAnswer(game.answerText ?? ''), [game.answerText])

  useEffect(() => {
    if (game.phase !== 'opening_questions') return
    const update = () => {
      const seconds = secondsRemaining(game.phaseDeadlineAt)
      setRemaining(seconds)
      if (seconds === 0) {
        void checkGameProgress(session, game.gameId)
          .then(onRefresh)
          .catch(() => onRefresh())
      }
    }
    update()
    const timer = window.setInterval(update, 500)
    return () => window.clearInterval(timer)
  }, [game.gameId, game.phase, game.phaseDeadlineAt, onRefresh, session])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!answer.trim()) {
      setLocalError('Write something first.')
      return
    }
    setSubmitting(true)
    setLocalError('')
    try {
      await submitOpeningAnswer(session, game.gameId, answer)
      await onRefresh()
    } catch (submitError) {
      setLocalError(friendlyError(submitError))
    } finally {
      setSubmitting(false)
    }
  }

  const retry = async () => {
    setRetrying(true)
    setLocalError('')
    try {
      await retryOutline(session, game.gameId)
      await onRefresh()
    } catch (retryError) {
      setLocalError(friendlyError(retryError))
    } finally {
      setRetrying(false)
    }
  }

  const shownError = localError || error
  if (game.phase === 'composing_outline') {
    return (
      <section className="card game-card loading-stage">
        <div className="film-reel" aria-hidden="true">✦</div>
        <span className="eyebrow">Please remain dramatically seated</span>
        <h2>The director is trying to make sense of your terrible ideas…</h2>
        <p>Everyone’s answers are locked in. This usually takes a moment.</p>
        <div className="loading-dots" aria-label="Composing outline"><i /><i /><i /></div>
      </section>
    )
  }

  if (game.phase === 'opening_complete') {
    return (
      <section className="card game-card completion-stage">
        <span className="eyebrow">Opening round complete</span>
        <h2>Somehow, that made a story.</h2>
        <p>The private outline is safely backstage, ready for the next gameplay wave.</p>
        <button className="button button-secondary" onClick={() => void onLeave()}>Leave game</button>
      </section>
    )
  }

  if (game.phase === 'error') {
    return (
      <section className="card game-card error-stage">
        <span className="eyebrow">Technical intermission</span>
        <h2>The director dropped the script.</h2>
        <p>{game.isHost ? game.aiError || 'Outline generation failed.' : 'The host can retry without losing anyone’s answers.'}</p>
        {shownError && <p className="error-message" role="alert">{shownError}</p>}
        {game.isHost && game.aiAttemptCount < 3 ? (
          <button className="button button-primary" disabled={retrying} onClick={() => void retry()}>
            {retrying ? 'Retrying…' : 'Retry outline'}
          </button>
        ) : (
          <div className="waiting-message"><i /><span>Waiting for the host…</span></div>
        )}
      </section>
    )
  }

  const submitted = Boolean(game.submittedAt)
  return (
    <section className="card game-card question-stage">
      <div className="question-topbar">
        <span className="status status-connected"><i /> Private question</span>
        <span className={`countdown ${remaining <= 10 ? 'countdown-urgent' : ''}`}>{remaining}s</span>
      </div>
      <div className="progress-track" aria-label={`${game.answerCount} of ${game.playerCount} answered`}>
        <i style={{ width: `${(game.answerCount / game.playerCount) * 100}%` }} />
      </div>
      <p className="answer-progress">{game.answerCount} of {game.playerCount} players have answered</p>
      <h2>{game.promptText}</h2>
      {submitted ? (
        <div className="submitted-state">
          <strong>Answer submitted</strong>
          <p>{game.answerText}</p>
          <span>Waiting for everyone else. Your answer is locked.</span>
        </div>
      ) : (
        <form className="answer-form" onSubmit={submit}>
          <label>
            Your answer
            <textarea
              autoFocus
              maxLength={250}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="Make it memorable…"
            />
          </label>
          <div className="character-count">{answer.length}/250</div>
          {shownError && <p className="error-message" role="alert">{shownError}</p>}
          <button className="button button-primary" disabled={submitting || remaining === 0}>
            {submitting ? 'Submitting…' : 'Submit answer'}
          </button>
        </form>
      )}
    </section>
  )
}

function secondsRemaining(deadline: string | null): number {
  if (!deadline) return 0
  return Math.max(0, Math.ceil((new Date(deadline).getTime() - Date.now()) / 1000))
}

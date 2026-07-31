import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchPremiereState, finishPremiere, friendlyError, replayToLobby, skipPremiereToCredits,
} from '../lib/lobby'
import type { Session } from '../types'

interface PremierePanel {
  panelId: string
  panelNumber: number
  narration: string
  dialogue: string | null
  drawingStatus: 'submitted' | 'blank' | 'missing' | 'failed'
  artistUsername: string
  drawingUrl: string | null
  audioUrl: string | null
  audioDurationMs: number | null
}
interface Shot { startMs: number; endMs: number; motion: string }
interface TimelineSegment {
  type: 'title' | 'panel' | 'credits'
  startMs: number
  durationMs: number
  panelId?: string
  audioStartMs?: number
  shots?: Shot[]
}
interface PremierePayload {
  title: string
  phase: string
  startedAt: string | null
  endsAt: string | null
  totalDurationMs: number
  timeline: { version: number; segments: TimelineSegment[]; music: null }
  players: string[]
  panels: PremierePanel[]
}
const RETURN_TO_MENU_ON_LOAD = 'scribbledicks:return-to-menu-on-load'

export function PremierePlayer({
  session,
  gameId,
  onRefresh,
  onLeave,
}: {
  session: Session
  gameId: string
  onRefresh: () => Promise<void>
  onLeave: () => Promise<void>
}) {
  const [payload, setPayload] = useState<PremierePayload | null>(null)
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState('')
  const [soundBlocked, setSoundBlocked] = useState(false)
  const [artworkCheck, setArtworkCheck] = useState({ total: 0, loaded: 0, failed: [] as string[], checking: false })
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const playbackRef = useRef({ segmentStartMs: 0, audioStartMs: 0, premiereStartMs: 0 })
  const finishing = useRef(false)

  const load = useCallback(async () => {
    try {
      setPayload(await fetchPremiereState(session, gameId) as PremierePayload)
      setError('')
    } catch (loadError) {
      setError(friendlyError(loadError))
    }
  }, [gameId, session])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!payload) return
    const artwork = payload.panels.filter((item) => item.drawingUrl)
    let cancelled = false
    setArtworkCheck({ total: artwork.length, loaded: 0, failed: [], checking: artwork.length > 0 })
    if (artwork.length === 0) return
    let loaded = 0
    const failed: string[] = []
    const checks = artwork.map((item) => new Promise<void>((resolve) => {
      const image = new Image()
      image.onload = () => {
        loaded += 1
        if (!cancelled) setArtworkCheck({ total: artwork.length, loaded, failed: [...failed], checking: true })
        resolve()
      }
      image.onerror = () => {
        failed.push(item.panelId)
        if (!cancelled) setArtworkCheck({ total: artwork.length, loaded, failed: [...failed], checking: true })
        resolve()
      }
      image.src = item.drawingUrl!
    }))
    void Promise.all(checks).then(() => {
      if (!cancelled) setArtworkCheck({ total: artwork.length, loaded, failed, checking: false })
    })
    return () => { cancelled = true }
  }, [payload])
  useEffect(() => {
    let frame = 0
    let lastPaint = 0
    const tick = () => {
      const time = Date.now()
      if (time - lastPaint >= 100) {
        lastPaint = time
        setNow(time)
      }
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [])

  const elapsed = payload?.startedAt
    ? Math.max(0, Math.min(payload.totalDurationMs, now - new Date(payload.startedAt).getTime()))
    : 0
  const segment = payload?.timeline?.segments.find((item) =>
    elapsed >= item.startMs && elapsed < item.startMs + item.durationMs)
    ?? payload?.timeline?.segments.at(-1)
  const panel = segment?.panelId
    ? payload?.panels.find((item) => item.panelId === segment.panelId) ?? null
    : null
  const segmentElapsed = segment ? elapsed - segment.startMs : 0
  useEffect(() => {
    if (!panel?.audioUrl || !segment) {
      audioRef.current?.pause()
      return
    }
    audioRef.current?.pause()
    const audio = new Audio(panel.audioUrl)
    audio.preload = 'auto'
    audio.dataset.panelId = panel.panelId
    audioRef.current = audio
    playbackRef.current = {
      segmentStartMs: segment.startMs,
      audioStartMs: segment.audioStartMs ?? 0,
      premiereStartMs: new Date(payload?.startedAt ?? 0).getTime(),
    }
    let startTimer = 0
    const synchronizeAndPlay = () => {
      const timing = playbackRef.current
      const rawDesired = (
        Date.now() - timing.premiereStartMs - timing.segmentStartMs - timing.audioStartMs
      ) / 1000
      if (rawDesired < 0) {
        window.clearTimeout(startTimer)
        startTimer = window.setTimeout(synchronizeAndPlay, Math.ceil(-rawDesired * 1000) + 10)
        return
      }
      const desired = rawDesired
      if (desired >= (panel.audioDurationMs ?? 0) / 1000) return
      if (Number.isFinite(audio.duration)) {
        audio.currentTime = Math.min(desired, Math.max(0, audio.duration - .05))
      } else {
        audio.currentTime = desired
      }
      void audio.play().then(() => setSoundBlocked(false)).catch(() => setSoundBlocked(true))
    }
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) synchronizeAndPlay()
    else audio.addEventListener('loadedmetadata', synchronizeAndPlay, { once: true })
    return () => {
      window.clearTimeout(startTimer)
      audio.removeEventListener('loadedmetadata', synchronizeAndPlay)
      audio.pause()
    }
  }, [panel?.panelId, panel?.audioUrl, panel?.audioDurationMs, payload?.startedAt, segment?.startMs, segment?.audioStartMs])

  useEffect(() => {
    const correction = window.setInterval(() => {
      const audio = audioRef.current
      if (!audio || audio.paused || audio.ended) return
      const timing = playbackRef.current
      const desired = Math.max(0, (
        Date.now() - timing.premiereStartMs - timing.segmentStartMs - timing.audioStartMs
      ) / 1000)
      if (Math.abs(audio.currentTime - desired) > 1.2) {
        audio.currentTime = Number.isFinite(audio.duration)
          ? Math.min(desired, Math.max(0, audio.duration - .05))
          : desired
      }
    }, 2000)
    return () => window.clearInterval(correction)
  }, [])

  useEffect(() => {
    if (!payload || elapsed < payload.totalDurationMs || finishing.current) return
    finishing.current = true
    void finishPremiere(session, gameId).then(onRefresh).catch(() => undefined)
  }, [elapsed, gameId, onRefresh, payload, session])

  useEffect(() => {
    if (!payload || (payload.phase !== 'game_complete' && elapsed < payload.totalDurationMs)) return
    localStorage.setItem(RETURN_TO_MENU_ON_LOAD, 'true')
  }, [elapsed, payload])

  const subtitle = useMemo(() => {
    if (!panel || !segment) return ''
    const words = panel.narration.split(/\s+/)
    const audioElapsed = Math.max(0, segmentElapsed - (segment.audioStartMs ?? 0))
    const duration = panel.audioDurationMs ?? 1
    if (audioElapsed >= duration) return ''
    const position = Math.min(words.length - 1, Math.floor(audioElapsed / duration * words.length))
    const wordsPerCue = 6
    const start = Math.max(0, Math.floor(position / wordsPerCue) * wordsPerCue)
    return words.slice(start, start + wordsPerCue).join(' ')
  }, [panel, segment, segmentElapsed])

  const enableSound = () => {
    setSoundBlocked(false)
    if (audioRef.current) void audioRef.current.play().catch(() => setSoundBlocked(true))
  }
  const retryArtwork = () => {
    setArtworkCheck((current) => ({ ...current, checking: true, failed: [] }))
    void load()
  }
  const skipToCredits = async () => {
    try {
      await skipPremiereToCredits(session, gameId)
      await load()
      await onRefresh()
    } catch (skipError) {
      setError(friendlyError(skipError))
    }
  }
  const playAgain = async () => {
    try {
      await replayToLobby(session, gameId)
      localStorage.removeItem(RETURN_TO_MENU_ON_LOAD)
      await onRefresh()
    } catch (replayError) {
      setError(friendlyError(replayError))
    }
  }
  const returnToMenu = async () => {
    localStorage.removeItem(RETURN_TO_MENU_ON_LOAD)
    await onLeave()
  }

  if (!payload) return <div className="premiere-screen premiere-loading"><div className="loader" /><p>Threading the projector…</p>{error && <p>{error}</p>}</div>
  if (payload.phase === 'game_complete' || elapsed >= payload.totalDurationMs) {
    return (
      <div className="premiere-screen post-credits">
        <span>The End</span>
        <h1>{payload.title}</h1>
        <p>Against all reasonable expectations, that was a movie.</p>
        {session.isHost
          ? <div className="post-credit-actions">
              <button className="button button-primary" onClick={() => void playAgain()}>Play again</button>
              <button className="button button-secondary" onClick={() => void returnToMenu()}>Return to menu</button>
            </div>
          : <div className="post-credit-actions">
              <p>Waiting for the host to gather the survivors.</p>
              <button className="button button-secondary" onClick={() => void returnToMenu()}>Return to menu</button>
            </div>}
      </div>
    )
  }

  return (
    <div className="premiere-screen">
      {segment?.type === 'title' && (
        <section className="premiere-title-card" key="title">
          <span>A Scribbledicks picture</span><h1>{payload.title}</h1>
        </section>
      )}
      {segment?.type === 'panel' && panel && (
        <section
          className="premiere-panel"
          key={panel.panelId}
          style={{ animationDuration: `${segment.durationMs}ms` }}
        >
          <div className="premiere-picture-frame" style={{ animationDuration: `${segment.durationMs}ms` }}>
            {panel.drawingUrl && !artworkCheck.failed.includes(panel.panelId) ? (
              <img
                key={panel.panelId}
                className="premiere-art"
                src={panel.drawingUrl}
                alt={`Panel ${panel.panelNumber}, drawn by ${panel.artistUsername}`}
              />
            ) : (
              <div className="missing-art"><span>Scene unavailable</span><strong>The artist has left this to your imagination.</strong></div>
            )}
          </div>
          <div className="premiere-subtitle" aria-live="polite">{subtitle || '\u00a0'}</div>
          {panel.dialogue && segmentElapsed > segment.durationMs * .55 && (
            <blockquote className="premiere-dialogue">“{panel.dialogue}”</blockquote>
          )}
        </section>
      )}
      {segment?.type === 'credits' && (
        <section className="premiere-credits">
          <div style={{ animationDuration: `${segment.durationMs}ms` }}>
            <h1>{payload.title}</h1>
            <h2>Written by</h2>
            {payload.players.map((name) => <p key={`writer-${name}`}>{name}</p>)}
            <h2>Artwork by</h2>
            {payload.players.map((name) => <p key={`artist-${name}`}>{name}</p>)}
            <h2>Directed by</h2><p>Artificial Intelligence</p>
            <strong>A Scribbledicks Production</strong>
          </div>
        </section>
      )}
      {soundBlocked && <button className="sound-gate" onClick={enableSound}>Tap for sound</button>}
      {artworkCheck.checking && (
        <div className="premiere-media-check" role="status">
          Checking artwork {artworkCheck.loaded} of {artworkCheck.total}…
        </div>
      )}
      {!artworkCheck.checking && artworkCheck.failed.length > 0 && (
        <div className="premiere-media-check premiere-media-failed" role="alert">
          <span>{artworkCheck.failed.length} picture{artworkCheck.failed.length === 1 ? '' : 's'} could not load.</span>
          <button type="button" onClick={retryArtwork}>Retry pictures</button>
        </div>
      )}
      {session.isHost && segment?.type === 'panel' && (
        <button className="premiere-skip" onClick={() => void skipToCredits()}>Skip to credits</button>
      )}
      {error && <div className="premiere-error">{error}</div>}
      <div className="premiere-progress"><i style={{ width: `${elapsed / payload.totalDurationMs * 100}%` }} /></div>
    </div>
  )
}

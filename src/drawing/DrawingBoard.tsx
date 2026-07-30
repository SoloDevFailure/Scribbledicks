import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type {
  DrawingBoardProps,
  DrawingLayout,
  DrawingSubmission,
  DrawingTool,
} from './types'

const WIDTH = 1280
const HEIGHT = 720
const HISTORY_LIMIT = 30
const colours = [
  '#17131f', '#ffffff', '#e94f64', '#f28c38', '#f4d44d',
  '#43a765', '#3d79d8', '#8b5bc2', '#865133', '#8b8792',
]
const thicknesses = [4, 10, 22, 40]
const textSizes = [28, 48, 72]
const toolLabels: Record<DrawingTool, string> = {
  pen: 'Pen',
  eraser: 'Eraser',
  fill: 'Fill',
  eyedropper: 'Eyedropper',
  line: 'Line',
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  text: 'Text',
}

interface Point {
  x: number
  y: number
}

function remainingSeconds(deadlineAt: string | null): number {
  if (!deadlineAt) return 90
  return Math.max(0, Math.ceil((new Date(deadlineAt).getTime() - Date.now()) / 1000))
}

function hexToRgba(hex: string): [number, number, number, number] {
  const normalized = hex.replace('#', '')
  const value = Number.parseInt(normalized, 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 255]
}

export default function DrawingBoard({
  prompt,
  deadlineAt,
  timerEnabled,
  artistsFinished,
  artistCount,
  locked = false,
  layout = 'auto',
  storageKey,
  submitLabel = 'Submit drawing',
  onLayoutChange,
  onSubmit,
}: DrawingBoardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const startPoint = useRef<Point | null>(null)
  const lastPoint = useRef<Point | null>(null)
  const previewBase = useRef<ImageData | null>(null)
  const drawing = useRef(false)
  const history = useRef<ImageData[]>([])
  const historyIndex = useRef(-1)
  const initialized = useRef(false)
  const autoSubmitted = useRef(false)

  const [tool, setTool] = useState<DrawingTool>('pen')
  const [colour, setColour] = useState('#17131f')
  const [thicknessIndex, setThicknessIndex] = useState(1)
  const [textSize, setTextSize] = useState(48)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [briefOpen, setBriefOpen] = useState(true)
  const [moreOpen, setMoreOpen] = useState(false)
  const [seconds, setSeconds] = useState(() => remainingSeconds(deadlineAt))
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')
  const [textPoint, setTextPoint] = useState<Point | null>(null)
  const [textValue, setTextValue] = useState('')

  const effectiveLocked = locked || submitted || submitting || (timerEnabled && seconds === 0)

  const context = useCallback(() => canvasRef.current?.getContext('2d', {
    willReadFrequently: true,
  }) ?? null, [])

  const updateHistoryButtons = useCallback(() => {
    setCanUndo(historyIndex.current > 0)
    setCanRedo(historyIndex.current >= 0 && historyIndex.current < history.current.length - 1)
  }, [])

  const saveDraft = useCallback(() => {
    if (!storageKey || !canvasRef.current) return
    try {
      localStorage.setItem(storageKey, canvasRef.current.toDataURL('image/png'))
    } catch {
      // Storage is a recovery convenience; drawing must continue if it is unavailable.
    }
  }, [storageKey])

  const commit = useCallback(() => {
    const ctx = context()
    if (!ctx) return
    const snapshot = ctx.getImageData(0, 0, WIDTH, HEIGHT)
    history.current = history.current.slice(0, historyIndex.current + 1)
    history.current.push(snapshot)
    if (history.current.length > HISTORY_LIMIT) history.current.shift()
    historyIndex.current = history.current.length - 1
    updateHistoryButtons()
    saveDraft()
  }, [context, saveDraft, updateHistoryButtons])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = context()
    if (!canvas || !ctx || initialized.current) return
    initialized.current = true
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, WIDTH, HEIGHT)
    const saved = storageKey ? localStorage.getItem(storageKey) : null
    if (!saved) {
      commit()
      return
    }
    const image = new Image()
    image.onload = () => {
      ctx.clearRect(0, 0, WIDTH, HEIGHT)
      ctx.drawImage(image, 0, 0, WIDTH, HEIGHT)
      commit()
    }
    image.onerror = () => commit()
    image.src = saved
  }, [commit, context, storageKey])

  useEffect(() => {
    setSeconds(remainingSeconds(deadlineAt))
    autoSubmitted.current = false
    if (!timerEnabled) return
    const update = () => setSeconds(remainingSeconds(deadlineAt))
    const timer = window.setInterval(update, 250)
    return () => window.clearInterval(timer)
  }, [deadlineAt, timerEnabled])

  const pointFromEvent = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const canvas = event.currentTarget
    const rect = canvas.getBoundingClientRect()
    return {
      x: (event.clientX - rect.left) * (WIDTH / rect.width),
      y: (event.clientY - rect.top) * (HEIGHT / rect.height),
    }
  }

  const strokeSettings = (ctx: CanvasRenderingContext2D) => {
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = thicknesses[thicknessIndex] ?? thicknesses[1]!
    ctx.strokeStyle = tool === 'eraser' ? 'rgba(0,0,0,1)' : colour
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over'
  }

  const floodFill = (point: Point) => {
    const ctx = context()
    if (!ctx) return
    const image = ctx.getImageData(0, 0, WIDTH, HEIGHT)
    const pixels = image.data
    const startX = Math.max(0, Math.min(WIDTH - 1, Math.floor(point.x)))
    const startY = Math.max(0, Math.min(HEIGHT - 1, Math.floor(point.y)))
    const start = (startY * WIDTH + startX) * 4
    const target: [number, number, number, number] = [
      pixels[start] ?? 0,
      pixels[start + 1] ?? 0,
      pixels[start + 2] ?? 0,
      pixels[start + 3] ?? 0,
    ]
    const replacement = hexToRgba(colour)
    if (target.every((channel, index) => channel === replacement[index])) return
    const tolerance = 24
    const matches = (offset: number) =>
      Math.abs((pixels[offset] ?? 0) - target[0]) <= tolerance &&
      Math.abs((pixels[offset + 1] ?? 0) - target[1]) <= tolerance &&
      Math.abs((pixels[offset + 2] ?? 0) - target[2]) <= tolerance &&
      Math.abs((pixels[offset + 3] ?? 0) - target[3]) <= tolerance
    const stack: number[] = [startY * WIDTH + startX]
    const visited = new Uint8Array(WIDTH * HEIGHT)
    while (stack.length) {
      const index = stack.pop()!
      if (visited[index]) continue
      visited[index] = 1
      const offset = index * 4
      if (!matches(offset)) continue
      pixels[offset] = replacement[0]
      pixels[offset + 1] = replacement[1]
      pixels[offset + 2] = replacement[2]
      pixels[offset + 3] = replacement[3]
      const x = index % WIDTH
      const y = Math.floor(index / WIDTH)
      if (x > 0) stack.push(index - 1)
      if (x < WIDTH - 1) stack.push(index + 1)
      if (y > 0) stack.push(index - WIDTH)
      if (y < HEIGHT - 1) stack.push(index + WIDTH)
    }
    ctx.putImageData(image, 0, 0)
    commit()
  }

  const pickColour = (point: Point) => {
    const pixel = context()?.getImageData(Math.floor(point.x), Math.floor(point.y), 1, 1).data
    if (!pixel) return
    setColour(`#${[pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0]
      .map((channel) => channel.toString(16).padStart(2, '0')).join('')}`)
    setTool('pen')
  }

  const drawShape = (ctx: CanvasRenderingContext2D, from: Point, to: Point) => {
    strokeSettings(ctx)
    ctx.beginPath()
    if (tool === 'line') {
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(to.x, to.y)
    } else if (tool === 'rectangle') {
      ctx.rect(from.x, from.y, to.x - from.x, to.y - from.y)
    } else {
      ctx.ellipse(
        (from.x + to.x) / 2,
        (from.y + to.y) / 2,
        Math.abs(to.x - from.x) / 2,
        Math.abs(to.y - from.y) / 2,
        0, 0, Math.PI * 2,
      )
    }
    ctx.stroke()
    ctx.globalCompositeOperation = 'source-over'
  }

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (effectiveLocked) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = pointFromEvent(event)
    if (tool === 'fill') return floodFill(point)
    if (tool === 'eyedropper') return pickColour(point)
    if (tool === 'text') {
      setTextPoint(point)
      setTextValue('')
      return
    }
    const ctx = context()
    if (!ctx) return
    drawing.current = true
    startPoint.current = point
    lastPoint.current = point
    previewBase.current = ctx.getImageData(0, 0, WIDTH, HEIGHT)
    if (tool === 'pen' || tool === 'eraser') {
      strokeSettings(ctx)
      ctx.beginPath()
      ctx.moveTo(point.x, point.y)
      ctx.lineTo(point.x + 0.01, point.y + 0.01)
      ctx.stroke()
    }
  }

  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || effectiveLocked) return
    event.preventDefault()
    const point = pointFromEvent(event)
    const ctx = context()
    if (!ctx || !startPoint.current) return
    if (tool === 'pen' || tool === 'eraser') {
      strokeSettings(ctx)
      ctx.beginPath()
      ctx.moveTo(lastPoint.current!.x, lastPoint.current!.y)
      ctx.lineTo(point.x, point.y)
      ctx.stroke()
      lastPoint.current = point
      return
    }
    if (previewBase.current) ctx.putImageData(previewBase.current, 0, 0)
    drawShape(ctx, startPoint.current, point)
  }

  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return
    event.preventDefault()
    drawing.current = false
    context()!.globalCompositeOperation = 'source-over'
    previewBase.current = null
    startPoint.current = null
    lastPoint.current = null
    commit()
  }

  const cancelActive = useCallback(() => {
    if (drawing.current && previewBase.current) context()?.putImageData(previewBase.current, 0, 0)
    drawing.current = false
    previewBase.current = null
    startPoint.current = null
    setTextPoint(null)
  }, [context])

  const undo = useCallback(() => {
    if (effectiveLocked || historyIndex.current <= 0) return
    historyIndex.current -= 1
    const snapshot = history.current[historyIndex.current]
    if (!snapshot) return
    context()?.putImageData(snapshot, 0, 0)
    updateHistoryButtons()
    saveDraft()
  }, [context, effectiveLocked, saveDraft, updateHistoryButtons])

  const redo = useCallback(() => {
    if (effectiveLocked || historyIndex.current >= history.current.length - 1) return
    historyIndex.current += 1
    const snapshot = history.current[historyIndex.current]
    if (!snapshot) return
    context()?.putImageData(snapshot, 0, 0)
    updateHistoryButtons()
    saveDraft()
  }, [context, effectiveLocked, saveDraft, updateHistoryButtons])

  const clear = () => {
    if (effectiveLocked || !window.confirm('Clear the whole canvas? You can undo this.')) return
    const ctx = context()
    if (!ctx) return
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, WIDTH, HEIGHT)
    commit()
  }

  const placeText = () => {
    if (!textPoint || !textValue.trim()) return
    const ctx = context()
    if (!ctx) return
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = colour
    ctx.font = `700 ${textSize}px Arial, sans-serif`
    ctx.textBaseline = 'top'
    ctx.fillText(textValue.trim(), textPoint.x, textPoint.y, WIDTH - textPoint.x - 12)
    setTextPoint(null)
    setTextValue('')
    commit()
  }

  const createSubmission = useCallback(async (): Promise<DrawingSubmission> => {
    const canvas = canvasRef.current!
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error('PNG export failed.')), 'image/png')
    })
    return {
      blob,
      dataUrl: canvas.toDataURL('image/png'),
      width: WIDTH,
      height: HEIGHT,
      commandData: JSON.stringify({ format: 'raster-snapshots-v1', historySteps: history.current.length }),
    }
  }, [])

  const submit = useCallback(async () => {
    if (submitted || submitting) return
    setSubmitting(true)
    setError('')
    try {
      await onSubmit(await createSubmission())
      setSubmitted(true)
      if (storageKey) localStorage.removeItem(storageKey)
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : 'Submission failed.')
    } finally {
      setSubmitting(false)
    }
  }, [createSubmission, onSubmit, storageKey, submitted, submitting])

  useEffect(() => {
    if (!timerEnabled || seconds !== 0 || autoSubmitted.current || submitted) return
    autoSubmitted.current = true
    void submit()
  }, [seconds, submit, submitted, timerEnabled])

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (textPoint || effectiveLocked) return
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select')) return
      const key = event.key.toLocaleLowerCase()
      if ((event.ctrlKey || event.metaKey) && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if ((event.ctrlKey || event.metaKey) && key === 'y') {
        event.preventDefault()
        redo()
        return
      }
      const shortcuts: Partial<Record<string, DrawingTool>> = {
        b: 'pen', p: 'pen', e: 'eraser', f: 'fill', i: 'eyedropper',
        l: 'line', r: 'rectangle', o: 'ellipse', t: 'text',
      }
      if (shortcuts[key]) {
        event.preventDefault()
        setTool(shortcuts[key]!)
      } else if (['1', '2', '3', '4'].includes(key)) {
        event.preventDefault()
        setThicknessIndex(Number(key) - 1)
      } else if (key === 'escape') {
        event.preventDefault()
        cancelActive()
      }
    }
    window.addEventListener('keydown', keyDown)
    return () => window.removeEventListener('keydown', keyDown)
  }, [cancelActive, effectiveLocked, redo, textPoint, undo])

  const exportPng = () => {
    const link = document.createElement('a')
    link.download = 'scribbledicks-drawing.png'
    link.href = canvasRef.current!.toDataURL('image/png')
    link.click()
  }

  const layoutClass = layout === 'auto' ? 'drawing-layout-auto' : `drawing-layout-${layout}`
  const toolButton = (value: DrawingTool) => (
    <button
      key={value}
      type="button"
      className={tool === value ? 'active' : ''}
      aria-pressed={tool === value}
      onClick={() => { setTool(value); setMoreOpen(false) }}
      disabled={effectiveLocked}
      title={toolLabels[value]}
    >
      <span aria-hidden="true">{toolIcon(value)}</span>
      <small>{toolLabels[value]}</small>
    </button>
  )

  return (
    <section className={`drawing-board ${layoutClass}`}>
      <header className="drawing-statusbar">
        <div>
          <span className="drawing-kicker">Storyboard studio</span>
          <strong>{submitted ? 'Drawing locked' : `${artistsFinished} of ${artistCount} artists finished`}</strong>
        </div>
        <div className={`drawing-timer ${timerEnabled && seconds <= 15 ? 'warning' : ''}`}>
          {timerEnabled ? `${seconds}s` : 'Timer off'}
        </div>
      </header>

      <div className="drawing-workspace">
        <div className="desktop-brief-bar">
          <span className="drawing-kicker">Your scene</span>
          <p>{prompt}</p>
        </div>

        <aside className="drawing-tools" aria-label="Drawing tools">
          {(['pen', 'eraser', 'fill', 'eyedropper', 'line', 'rectangle', 'ellipse', 'text'] as DrawingTool[])
            .map(toolButton)}
        </aside>

        <main className="drawing-main">
          <div className="drawing-options">
            <span><b>{toolLabels[tool]}</b></span>
            <div className="thickness-options" aria-label="Brush thickness">
              {thicknesses.map((value, index) => (
                <button
                  type="button"
                  key={value}
                  className={thicknessIndex === index ? 'active' : ''}
                  aria-label={`Thickness ${index + 1}`}
                  onClick={() => setThicknessIndex(index)}
                  disabled={effectiveLocked}
                >
                  <i style={{ width: Math.min(24, 4 + index * 6), height: Math.min(24, 4 + index * 6) }} />
                </button>
              ))}
            </div>
            {tool === 'text' && (
              <select value={textSize} onChange={(event) => setTextSize(Number(event.target.value))}>
                {textSizes.map((size) => <option key={size} value={size}>{size}px</option>)}
              </select>
            )}
            <button type="button" onClick={undo} disabled={!canUndo || effectiveLocked}>Undo</button>
            <button type="button" onClick={redo} disabled={!canRedo || effectiveLocked}>Redo</button>
            <button type="button" className="danger-link" onClick={clear} disabled={effectiveLocked}>Clear</button>
          </div>

          <details className="compact-brief" open={briefOpen} onToggle={(event) => setBriefOpen(event.currentTarget.open)}>
            <summary>Drawing brief</summary>
            <p>{prompt}</p>
          </details>

          <div className={`canvas-frame ${effectiveLocked ? 'locked' : ''}`}>
            <canvas
              ref={canvasRef}
              width={WIDTH}
              height={HEIGHT}
              aria-label="Drawing canvas"
              onPointerDown={pointerDown}
              onPointerMove={pointerMove}
              onPointerUp={pointerUp}
              onPointerCancel={pointerUp}
              onContextMenu={(event) => event.preventDefault()}
            />
            {effectiveLocked && <div className="canvas-lock">{submitted ? 'Submitted' : submitting ? 'Submitting…' : 'Time is up'}</div>}
          </div>

          <div className="desktop-bottom-controls">
            <div className="colour-palette" aria-label="Colour palette">
              <span className="current-colour" style={{ background: colour }} title="Current colour" />
              {colours.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={colour === value ? 'active' : ''}
                  style={{ background: value }}
                  aria-label={`Use colour ${value}`}
                  onClick={() => setColour(value)}
                  disabled={effectiveLocked}
                />
              ))}
              <label className="custom-colour">
                <span>Custom</span>
                <input type="color" value={colour} onChange={(event) => setColour(event.target.value)} disabled={effectiveLocked} />
              </label>
            </div>
            <div className="desktop-submit-actions">
              {error && <p className="error-message" role="alert">{error}</p>}
              {submitted
                ? <div className="drawing-success"><strong>Drawing submitted</strong><span>Waiting for the other artists.</span></div>
                : <button type="button" className="button button-primary" onClick={() => void submit()} disabled={submitting}>
                    {submitting ? 'Submitting…' : submitLabel}
                  </button>}
              <button type="button" className="button button-secondary" onClick={exportPng}>Export PNG</button>
            </div>
          </div>

          <div className="compact-dock">
            {(['pen', 'eraser'] as DrawingTool[]).map(toolButton)}
            <label className="dock-colour" style={{ background: colour }} title="Colour">
              <input type="color" value={colour} onChange={(event) => setColour(event.target.value)} />
              <small>Colour</small>
            </label>
            <button type="button" onClick={() => setThicknessIndex((thicknessIndex + 1) % 4)}>
              <span className="dock-size">{thicknessIndex + 1}</span><small>Size</small>
            </button>
            <button type="button" onClick={undo} disabled={!canUndo}><span>↶</span><small>Undo</small></button>
            <button type="button" onClick={() => setMoreOpen(!moreOpen)}><span>•••</span><small>More</small></button>
          </div>
          {moreOpen && (
            <div className="compact-more">
              {(['fill', 'eyedropper', 'line', 'rectangle', 'ellipse', 'text'] as DrawingTool[]).map(toolButton)}
              <button type="button" onClick={redo} disabled={!canRedo}><span>↷</span><small>Redo</small></button>
              <button type="button" onClick={clear}><span>×</span><small>Clear</small></button>
            </div>
          )}
          <div className="compact-submit">
            {error && <p className="error-message" role="alert">{error}</p>}
            {submitted
              ? <div className="drawing-success"><strong>Drawing submitted</strong><span>Waiting for the other artists.</span></div>
              : <button type="button" className="button button-primary" onClick={() => void submit()} disabled={submitting}>
                  {submitting ? 'Submitting…' : submitLabel}
                </button>}
            <button type="button" className="button button-secondary" onClick={exportPng}>Export PNG</button>
          </div>
        </main>

      </div>

      {textPoint && (
        <div className="text-entry-backdrop" role="dialog" aria-modal="true" aria-label="Add text">
          <form onSubmit={(event) => { event.preventDefault(); placeText() }}>
            <label>Text<input autoFocus maxLength={80} value={textValue} onChange={(event) => setTextValue(event.target.value)} /></label>
            <label>Size<select value={textSize} onChange={(event) => setTextSize(Number(event.target.value))}>
              {textSizes.map((size) => <option key={size} value={size}>{size}px</option>)}
            </select></label>
            <div><button type="button" className="button button-secondary" onClick={() => setTextPoint(null)}>Cancel</button>
              <button className="button button-primary">Place text</button></div>
          </form>
        </div>
      )}
    </section>
  )
}

function toolIcon(tool: DrawingTool): string {
  return {
    pen: '✎', eraser: '▱', fill: '◩', eyedropper: '⌁',
    line: '╱', rectangle: '□', ellipse: '○', text: 'T',
  }[tool]
}

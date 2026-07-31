import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  Circle,
  Eraser,
  PaintBucket,
  Pencil,
  Pipette,
  Slash,
  Square,
  Type,
  type LucideIcon,
} from 'lucide-react'
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
const toolShortLabels: Record<DrawingTool, string> = {
  ...toolLabels,
  eyedropper: 'Dropper',
  rectangle: 'Rect',
}

interface Point {
  x: number
  y: number
}

interface TextBox {
  x: number
  y: number
  width: number
  height: number
  text: string
  colour: string
  fontSize: number
  autoFit: boolean
}

interface TextTransform {
  mode: 'move' | 'resize'
  pointerX: number
  pointerY: number
  original: TextBox
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

function wrappedLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const paragraphs = text.split('\n')
  const lines: string[] = []
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      lines.push('')
      continue
    }
    let line = words[0]!
    for (const word of words.slice(1)) {
      const candidate = `${line} ${word}`
      if (ctx.measureText(candidate).width <= maxWidth) line = candidate
      else {
        lines.push(line)
        line = word
      }
    }
    lines.push(line)
  }
  return lines
}

function fittedFontSize(
  ctx: CanvasRenderingContext2D,
  box: Pick<TextBox, 'width' | 'height' | 'text'>,
  preferred = 72,
): number {
  for (let size = Math.min(preferred, Math.floor(box.height * .7)); size >= 18; size -= 2) {
    ctx.font = `700 ${size}px Arial, sans-serif`
    const lines = wrappedLines(ctx, box.text || 'Type here', Math.max(20, box.width - 20))
    if (lines.length * size * 1.18 <= box.height - 16) return size
  }
  return 18
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
  roundLabel,
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
  const textTransform = useRef<TextTransform | null>(null)
  const textInputRef = useRef<HTMLTextAreaElement>(null)

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
  const [activeTextBox, setActiveTextBox] = useState<TextBox | null>(null)
  const [canvasDisplayWidth, setCanvasDisplayWidth] = useState(1)

  const effectiveLocked = locked || submitted || submitting || (timerEnabled && seconds === 0)

  const context = useCallback(() => canvasRef.current?.getContext('2d', {
    willReadFrequently: true,
  }) ?? null, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const update = () => setCanvasDisplayWidth(canvas.getBoundingClientRect().width || 1)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

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

  const flattenTextBox = useCallback((box: TextBox) => {
    if (!box.text.trim()) return
    const ctx = context()
    if (!ctx) return
    const size = box.autoFit ? fittedFontSize(ctx, box) : box.fontSize
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = box.colour
    ctx.font = `700 ${size}px Arial, sans-serif`
    ctx.textBaseline = 'top'
    const lines = wrappedLines(ctx, box.text.trim(), Math.max(20, box.width - 20))
    const lineHeight = size * 1.18
    lines.slice(0, Math.max(1, Math.floor((box.height - 16) / lineHeight)))
      .forEach((line, index) => ctx.fillText(line, box.x + 10, box.y + 8 + index * lineHeight))
  }, [context])

  const commitActiveText = useCallback(() => {
    if (!activeTextBox) return
    flattenTextBox(activeTextBox)
    setActiveTextBox(null)
    commit()
  }, [activeTextBox, commit, flattenTextBox])

  const chooseTool = (nextTool: DrawingTool) => {
    if (activeTextBox && nextTool !== 'text') commitActiveText()
    setTool(nextTool)
    setMoreOpen(false)
  }

  const chooseColour = (nextColour: string) => {
    setColour(nextColour)
    setActiveTextBox((current) => current ? { ...current, colour: nextColour } : current)
  }

  const chooseTextSize = (nextSize: number) => {
    if (nextSize > 0) setTextSize(nextSize)
    setActiveTextBox((current) => {
      if (!current) return current
      if (nextSize === 0) {
        return { ...current, fontSize: fittedFontSize(context()!, current), autoFit: true }
      }
      return { ...current, fontSize: nextSize, autoFit: false }
    })
  }

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
    chooseColour(`#${[pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0]
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
    if (activeTextBox) {
      commitActiveText()
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = pointFromEvent(event)
    if (tool === 'fill') return floodFill(point)
    if (tool === 'eyedropper') return pickColour(point)
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
    if (tool === 'text') {
      ctx.save()
      ctx.setLineDash([10, 7])
      ctx.lineWidth = 3
      ctx.strokeStyle = '#367fca'
      ctx.strokeRect(
        startPoint.current.x,
        startPoint.current.y,
        point.x - startPoint.current.x,
        point.y - startPoint.current.y,
      )
      ctx.restore()
      return
    }
    drawShape(ctx, startPoint.current, point)
  }

  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return
    event.preventDefault()
    drawing.current = false
    const ctx = context()!
    ctx.globalCompositeOperation = 'source-over'
    if (tool === 'text' && startPoint.current) {
      const end = pointFromEvent(event)
      const base = previewBase.current
      if (base) ctx.putImageData(base, 0, 0)
      const x = Math.max(0, Math.min(startPoint.current.x, end.x))
      const y = Math.max(0, Math.min(startPoint.current.y, end.y))
      const width = Math.min(WIDTH - x, Math.max(80, Math.abs(end.x - startPoint.current.x)))
      const height = Math.min(HEIGHT - y, Math.max(50, Math.abs(end.y - startPoint.current.y)))
      setActiveTextBox({
        x, y, width, height, text: '', colour, fontSize: textSize, autoFit: true,
      })
      window.setTimeout(() => textInputRef.current?.focus(), 0)
      previewBase.current = null
      startPoint.current = null
      lastPoint.current = null
      return
    }
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
    setActiveTextBox(null)
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

  const beginTextTransform = (
    event: ReactPointerEvent<HTMLElement>,
    mode: TextTransform['mode'],
  ) => {
    if (!activeTextBox) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    textTransform.current = {
      mode,
      pointerX: event.clientX,
      pointerY: event.clientY,
      original: { ...activeTextBox },
    }
  }

  const moveTextTransform = (event: ReactPointerEvent<HTMLElement>) => {
    const transform = textTransform.current
    if (!transform) return
    event.preventDefault()
    const logicalScale = WIDTH / canvasDisplayWidth
    const dx = (event.clientX - transform.pointerX) * logicalScale
    const dy = (event.clientY - transform.pointerY) * logicalScale
    if (transform.mode === 'move') {
      setActiveTextBox({
        ...transform.original,
        x: Math.max(0, Math.min(WIDTH - transform.original.width, transform.original.x + dx)),
        y: Math.max(0, Math.min(HEIGHT - transform.original.height, transform.original.y + dy)),
      })
    } else {
      const resized = {
        ...transform.original,
        width: Math.max(80, Math.min(WIDTH - transform.original.x, transform.original.width + dx)),
        height: Math.max(50, Math.min(HEIGHT - transform.original.y, transform.original.height + dy)),
      }
      if (resized.autoFit) resized.fontSize = fittedFontSize(context()!, resized)
      setActiveTextBox(resized)
    }
  }

  const endTextTransform = () => {
    textTransform.current = null
    window.setTimeout(() => textInputRef.current?.focus(), 0)
  }

  const createSubmission = useCallback(async (): Promise<DrawingSubmission> => {
    if (activeTextBox) commitActiveText()
    const canvas = canvasRef.current!
    const pixels = context()!.getImageData(0, 0, WIDTH, HEIGHT).data
    let isBlank = true
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const alpha = pixels[offset + 3] ?? 0
      if (alpha > 0 && (
        (pixels[offset] ?? 255) < 250 ||
        (pixels[offset + 1] ?? 255) < 250 ||
        (pixels[offset + 2] ?? 255) < 250
      )) {
        isBlank = false
        break
      }
    }
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error('PNG export failed.')), 'image/png')
    })
    return {
      blob,
      dataUrl: canvas.toDataURL('image/png'),
      width: WIDTH,
      height: HEIGHT,
      isBlank,
      commandData: JSON.stringify({ format: 'raster-snapshots-v1', historySteps: history.current.length }),
    }
  }, [activeTextBox, commitActiveText, context])

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
      const target = event.target as HTMLElement | null
      const key = event.key.toLocaleLowerCase()
      const typing = Boolean(target?.matches('input, textarea, select'))
      if (key === 'escape' && activeTextBox) {
        event.preventDefault()
        cancelActive()
        return
      }
      if (typing) return
      if (effectiveLocked) return
      if (activeTextBox && (key === 'delete' || key === 'backspace')) {
        event.preventDefault()
        setActiveTextBox(null)
        return
      }
      if (key === 'escape') {
        event.preventDefault()
        cancelActive()
        return
      }
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
      if (activeTextBox) return
      const shortcuts: Partial<Record<string, DrawingTool>> = {
        b: 'pen', p: 'pen', e: 'eraser', f: 'fill', i: 'eyedropper',
        l: 'line', r: 'rectangle', o: 'ellipse', t: 'text',
      }
      if (shortcuts[key]) {
        event.preventDefault()
        chooseTool(shortcuts[key]!)
      } else if (['1', '2', '3', '4'].includes(key)) {
        event.preventDefault()
        setThicknessIndex(Number(key) - 1)
      }
    }
    window.addEventListener('keydown', keyDown)
    return () => window.removeEventListener('keydown', keyDown)
  }, [activeTextBox, cancelActive, effectiveLocked, redo, undo])

  const exportPng = () => {
    if (activeTextBox) commitActiveText()
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
      onClick={() => chooseTool(value)}
      disabled={effectiveLocked}
      title={toolLabels[value]}
    >
      <span className="tool-icon" aria-hidden="true">{toolIcon(value)}</span>
      <small>{toolShortLabels[value]}</small>
    </button>
  )

  return (
    <section className={`drawing-board ${layoutClass}`}>
      <header className="drawing-statusbar">
        <div>
          <span className="drawing-kicker">{roundLabel ?? 'Storyboard studio'}</span>
          <strong>{submitted ? 'Drawing locked' : `${artistsFinished} of ${artistCount} artists finished`}</strong>
        </div>
        <div className={`drawing-timer ${
          timerEnabled && seconds <= 5 ? 'critical' : timerEnabled && seconds <= 15 ? 'warning' : ''
        }`}>
          {timerEnabled ? `${seconds}s` : 'Timer off'}
        </div>
        {onLayoutChange && (
          <label className="drawing-layout-picker">
            <span>Layout</span>
            <select value={layout} onChange={(event) => onLayoutChange(event.target.value as DrawingLayout)}>
              <option value="auto">Auto</option>
              <option value="desktop">Desktop</option>
              <option value="compact">Compact</option>
            </select>
          </label>
        )}
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
              <select value={activeTextBox?.autoFit ? 0 : (activeTextBox?.fontSize ?? textSize)} onChange={(event) => chooseTextSize(Number(event.target.value))}>
                <option value={0}>Auto fit</option>
                <option value={18}>18px</option>
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
            {activeTextBox && (
              <div
                className="active-text-box"
                style={{
                  left: `${activeTextBox.x / WIDTH * 100}%`,
                  top: `${activeTextBox.y / HEIGHT * 100}%`,
                  width: `${activeTextBox.width / WIDTH * 100}%`,
                  height: `${activeTextBox.height / HEIGHT * 100}%`,
                  color: activeTextBox.colour,
                  fontSize: `${activeTextBox.fontSize * canvasDisplayWidth / WIDTH}px`,
                }}
                onPointerMove={moveTextTransform}
                onPointerUp={endTextTransform}
                onPointerCancel={endTextTransform}
              >
                <button
                  type="button"
                  className="text-move-handle"
                  aria-label="Move text box"
                  title="Drag to move"
                  onPointerDown={(event) => beginTextTransform(event, 'move')}
                >
                  Move
                </button>
                <textarea
                  ref={textInputRef}
                  aria-label="Text box content"
                  value={activeTextBox.text}
                  placeholder="Type here…"
                  onChange={(event) => {
                    const text = event.target.value
                    setActiveTextBox((current) => {
                      if (!current) return current
                      const updated = { ...current, text }
                      if (updated.autoFit) updated.fontSize = fittedFontSize(context()!, updated)
                      return updated
                    })
                  }}
                />
                <i className="text-handle text-handle-nw" />
                <i className="text-handle text-handle-ne" />
                <i className="text-handle text-handle-sw" />
                <button
                  type="button"
                  className="text-resize-handle"
                  aria-label="Resize text box"
                  title="Drag to resize"
                  onPointerDown={(event) => beginTextTransform(event, 'resize')}
                />
              </div>
            )}
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
                  onClick={() => chooseColour(value)}
                  disabled={effectiveLocked}
                />
              ))}
              <label className="custom-colour">
                <span>Custom</span>
                <input type="color" value={colour} onChange={(event) => chooseColour(event.target.value)} disabled={effectiveLocked} />
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
              <input type="color" value={colour} onChange={(event) => chooseColour(event.target.value)} />
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

    </section>
  )
}

function toolIcon(tool: DrawingTool) {
  const icons: Record<DrawingTool, LucideIcon> = {
    pen: Pencil,
    eraser: Eraser,
    fill: PaintBucket,
    eyedropper: Pipette,
    line: Slash,
    rectangle: Square,
    ellipse: Circle,
    text: Type,
  }
  const Icon = icons[tool]
  return <Icon size={28} strokeWidth={2.2} />
}

import { useMemo, useState } from 'react'
import DrawingBoard from './DrawingBoard'
import type { DrawingLayout, DrawingSubmission } from './types'

const prompt = 'Draw Mabel, a nervous lime-green octopus wearing a red bicycle helmet, steering a tiny yellow school bus across a cracked moon while three stern pigeons chase it on roller skates.'

export default function DrawingSandbox() {
  const [layout, setLayout] = useState<DrawingLayout>(() =>
    (localStorage.getItem('scribbledicks:drawing-layout') as DrawingLayout | null) ?? 'auto')
  const [timerEnabled, setTimerEnabled] = useState(false)
  const [timerRun, setTimerRun] = useState(0)
  const [result, setResult] = useState('Ready—nothing leaves this browser.')
  const [submissionMode, setSubmissionMode] = useState<'success' | 'failure'>('success')
  const deadlineAt = useMemo(
    () => timerEnabled ? new Date(Date.now() + 120_000).toISOString() : null,
    [timerEnabled, timerRun],
  )

  const changeLayout = (next: DrawingLayout) => {
    setLayout(next)
    localStorage.setItem('scribbledicks:drawing-layout', next)
  }

  const submit = async (drawing: DrawingSubmission) => {
    await new Promise((resolve) => window.setTimeout(resolve, 700))
    if (submissionMode === 'failure') throw new Error('Simulated upload failure. Your drawing is still safe.')
    setResult(`Simulated success: ${(drawing.blob.size / 1024).toFixed(1)} KB PNG generated locally.`)
  }

  return (
    <main className="drawing-sandbox">
      <div className="sandbox-controls">
        <div><span>Development route</span><strong>Drawing Sandbox</strong></div>
        <label>Layout
          <select value={layout} onChange={(event) => changeLayout(event.target.value as DrawingLayout)}>
            <option value="auto">Auto detect</option>
            <option value="desktop">Desktop</option>
            <option value="compact">Compact</option>
          </select>
        </label>
        <label className="sandbox-toggle">
          <input
            type="checkbox"
            checked={timerEnabled}
            onChange={(event) => { setTimerEnabled(event.target.checked); setTimerRun((value) => value + 1) }}
          />
          120-second timer
        </label>
        <label>Submission
          <select value={submissionMode} onChange={(event) => setSubmissionMode(event.target.value as 'success' | 'failure')}>
            <option value="success">Simulate success</option>
            <option value="failure">Simulate failure</option>
          </select>
        </label>
        {timerEnabled && <button type="button" onClick={() => setTimerRun((value) => value + 1)}>Restart timer</button>}
        <output>{result}</output>
      </div>
      <DrawingBoard
        key={timerRun}
        prompt={prompt}
        deadlineAt={deadlineAt}
        timerEnabled={timerEnabled}
        artistsFinished={3}
        artistCount={5}
        layout={layout}
        storageKey="scribbledicks:drawing-sandbox-draft"
        onSubmit={submit}
      />
    </main>
  )
}

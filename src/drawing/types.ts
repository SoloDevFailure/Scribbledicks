export type DrawingTool =
  | 'pen'
  | 'eraser'
  | 'fill'
  | 'eyedropper'
  | 'line'
  | 'rectangle'
  | 'ellipse'
  | 'text'

export type DrawingLayout = 'auto' | 'desktop' | 'compact'

export interface DrawingSubmission {
  blob: Blob
  dataUrl: string
  width: number
  height: number
  isBlank: boolean
  commandData: string
}

export interface DrawingBoardProps {
  prompt: string
  deadlineAt: string | null
  timerEnabled: boolean
  artistsFinished: number
  artistCount: number
  locked?: boolean
  layout?: DrawingLayout
  storageKey?: string
  submitLabel?: string
  roundLabel?: string
  onLayoutChange?: (layout: DrawingLayout) => void
  onSubmit: (submission: DrawingSubmission) => Promise<void>
}

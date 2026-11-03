import { FilesetResolver, ImageSegmenter, type ImageSegmenterResult } from '@mediapipe/tasks-vision'
import { startWorkerClock } from './worker-clock'

// Both served from our own origin (see vite.config.ts and public/models).
const WASM_BASE = '/mediapipe'
const MODEL_URL = '/models/selfie_segmenter.tflite'
// The network costs 5–20 ms a frame on a laptop. 15 a second leaves the page
// room to breathe; the mask lagging one frame behind fast movement is hard to see.
const SEGMENT_FPS = 15
const OUTPUT_FPS = 24
// Confidence between these fades from background to person, which feathers
// hair and shoulders instead of cutting a jagged outline.
const PERSON_FLOOR = 0.18
const PERSON_CEILING = 0.78
// Slower than this on average (under ~15 fps), and blur gives up rather than
// make the whole call stutter.
const SLOW_FRAME_MS = 60
const SLOW_WINDOW = 30
// The first frames include compiling the model for this device, which can
// take a few hundred ms each. They say nothing about how fast it runs after.
const WARMUP_FRAMES = 15

export type BackgroundFailure = 'slow' | 'error'

export interface BackgroundOptions {
  /** Pixels of blur behind you. Ignored with `image`. */
  blurPx?: number
  /** A picture behind you instead of blur. */
  image?: HTMLImageElement
  /** It stopped working mid-call. The caller swaps the raw track back. */
  onFailure: (reason: BackgroundFailure) => void
}

// Loaded once per page and shared: the model and WASM are the slow part.
let segmenterPromise: Promise<ImageSegmenter> | null = null

function getSegmenter(): Promise<ImageSegmenter> {
  segmenterPromise ??= (async () => {
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE)
    const create = (delegate: 'GPU' | 'CPU') =>
      ImageSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        outputCategoryMask: false,
        outputConfidenceMasks: true,
        runningMode: 'VIDEO',
      })
    // GPU when there is one; some machines and headless browsers only manage the CPU.
    try {
      return await create('GPU')
    } catch {
      return await create('CPU')
    }
  })().catch((err) => {
    // A later toggle tries again from scratch.
    segmenterPromise = null
    throw err
  })
  return segmenterPromise
}

/**
 * Raw camera track in, processed track out. The person stays sharp; the rest
 * of the frame is blurred, or replaced by a picture. Everything happens on
 * canvases, and the result leaves through canvas.captureStream().
 */
export class BackgroundProcessor {
  private readonly opts: BackgroundOptions
  private video: HTMLVideoElement | null = null
  private bg: CanvasRenderingContext2D | null = null
  private fg: CanvasRenderingContext2D | null = null
  private out: CanvasRenderingContext2D | null = null
  private output: MediaStreamTrack | null = null
  private stopClock: (() => void) | null = null
  private busy = false
  private stopped = false
  private readonly frameMs: number[] = []
  private framesSeen = 0

  constructor(opts: BackgroundOptions) {
    this.opts = opts
  }

  /** Throws if the model can't load or the browser can't run it; the caller keeps the raw track. */
  async start(raw: MediaStreamTrack): Promise<MediaStreamTrack> {
    const segmenter = await getSegmenter()
    if (this.stopped) throw new Error('stopped while loading')

    const { width = 640, height = 480 } = raw.getSettings()
    const video = document.createElement('video')
    video.srcObject = new MediaStream([raw])
    video.muted = true
    video.playsInline = true
    await video.play()
    if (this.stopped) throw new Error('stopped while starting')
    this.video = video

    const canvas = (readsPixels = false) => {
      const c = document.createElement('canvas')
      c.width = width
      c.height = height
      const ctx = c.getContext('2d', { willReadFrequently: readsPixels })
      if (!ctx) throw new Error('no 2d canvas')
      return ctx
    }
    this.bg = canvas()
    // Its pixels are read and written every frame.
    this.fg = canvas(true)
    this.out = canvas()

    const output = this.out.canvas.captureStream(OUTPUT_FPS).getVideoTracks()[0]
    if (!output) throw new Error('captureStream gave no track')
    this.output = output

    this.stopClock = startWorkerClock(1000 / SEGMENT_FPS, () => this.frame(segmenter, width, height))
    return output
  }

  stop(): void {
    this.stopped = true
    this.stopClock?.()
    this.stopClock = null
    this.output?.stop()
    this.output = null
    if (this.video) {
      this.video.pause()
      this.video.srcObject = null
    }
    this.video = null
    this.bg = this.fg = this.out = null
  }

  private frame(segmenter: ImageSegmenter, width: number, height: number): void {
    const video = this.video
    if (this.stopped || this.busy || !video || video.readyState < 2) return
    this.busy = true
    const started = performance.now()
    try {
      // Synchronous: the masks are only valid inside the callback.
      segmenter.segmentForVideo(video, started, (result) => this.composite(result, video, width, height))
    } catch (err) {
      console.warn('[effects] background frame failed', err)
      this.fail('error')
      return
    } finally {
      this.busy = false
    }
    this.watchSpeed(performance.now() - started)
  }

  private composite(result: ImageSegmenterResult, video: HTMLVideoElement, width: number, height: number): void {
    const { bg, fg, out } = this
    const mask = result.confidenceMasks?.[0]
    try {
      if (!bg || !fg || !out || !mask) return
      const confidence = mask.getAsFloat32Array()

      if (this.opts.image) {
        drawCover(bg, this.opts.image, width, height)
      } else {
        bg.filter = `blur(${this.opts.blurPx ?? 14}px)`
        bg.drawImage(video, 0, 0, width, height)
        bg.filter = 'none'
      }

      // The person, sharp, transparent wherever the network sees background.
      fg.drawImage(video, 0, 0, width, height)
      const pixels = fg.getImageData(0, 0, width, height)
      for (let i = 0; i < confidence.length; i++) {
        pixels.data[i * 4 + 3] = Math.round(smoothstep(PERSON_FLOOR, PERSON_CEILING, confidence[i] ?? 0) * 255)
      }
      fg.putImageData(pixels, 0, 0)

      out.drawImage(bg.canvas, 0, 0)
      out.drawImage(fg.canvas, 0, 0)
    } finally {
      result.confidenceMasks?.forEach((m) => m.close())
    }
  }

  /** Averages the last 30 frames after warm-up; too slow, and blur switches itself off. */
  private watchSpeed(ms: number): void {
    if (++this.framesSeen <= WARMUP_FRAMES) return
    this.frameMs.push(ms)
    if (this.frameMs.length > SLOW_WINDOW) this.frameMs.shift()
    if (this.frameMs.length < SLOW_WINDOW) return
    const average = this.frameMs.reduce((a, b) => a + b, 0) / this.frameMs.length
    if (average > SLOW_FRAME_MS) {
      console.warn(`[effects] background blur too slow (${Math.round(average)} ms a frame)`)
      this.fail('slow')
    }
  }

  private fail(reason: BackgroundFailure): void {
    if (this.stopped) return
    this.stop()
    this.opts.onFailure(reason)
  }
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const x = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
  return x * x * (3 - 2 * x)
}

/** Scales the picture to fill the frame, cropping the overflow evenly. */
function drawCover(ctx: CanvasRenderingContext2D, image: HTMLImageElement, width: number, height: number): void {
  const w = image.naturalWidth || image.width
  const h = image.naturalHeight || image.height
  if (!w || !h) return
  const scale = Math.max(width / w, height / h)
  ctx.drawImage(image, (width - w * scale) / 2, (height - h * scale) / 2, w * scale, h * scale)
}

/** Loads a picture for `image`. Rejects for anything the browser can't decode. */
export function loadBackgroundImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('background image failed to load'))
    image.src = src
  })
}

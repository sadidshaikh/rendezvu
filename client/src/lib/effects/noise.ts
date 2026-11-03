import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import workletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import wasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import simdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'

// RNNoise works on 10 ms frames of 480 samples at exactly this rate.
const SAMPLE_RATE = 48_000

// Fetched once per page; the SIMD build where the browser supports it.
let wasmPromise: Promise<ArrayBuffer> | null = null

function getWasm(): Promise<ArrayBuffer> {
  wasmPromise ??= loadRnnoise({ url: wasmUrl, simdUrl }).catch((err) => {
    wasmPromise = null
    throw err
  })
  return wasmPromise
}

/**
 * Raw mic track in, processed track out. RNNoise runs as WebAssembly in an
 * AudioWorklet, on the browser's audio thread, so a busy page can't make the
 * audio stutter.
 */
export class NoiseSuppressor {
  private readonly onFailure: () => void
  private ctx: AudioContext | null = null
  private node: RnnoiseWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private output: MediaStreamTrack | null = null
  private stopped = false

  /** `onFailure`: it stopped working mid-call. The caller swaps the raw track back. */
  constructor(onFailure: () => void) {
    this.onFailure = onFailure
  }

  /** Throws if anything can't load or the audio can't run; the caller keeps the raw track. */
  async start(raw: MediaStreamTrack): Promise<MediaStreamTrack> {
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
    this.ctx = ctx
    // A context created outside a click can start suspended, and a suspended
    // one sends silence. Better the raw mic than nothing.
    await ctx.resume().catch(() => {})
    const [wasmBinary] = await Promise.all([getWasm(), ctx.audioWorklet.addModule(workletUrl)])
    if (this.stopped) throw new Error('stopped while loading')
    if (ctx.state !== 'running') throw new Error(`audio context is ${ctx.state}`)

    const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary })
    node.onprocessorerror = () => {
      console.warn('[effects] noise suppression processor failed')
      this.fail()
    }
    this.node = node
    this.source = ctx.createMediaStreamSource(new MediaStream([raw]))
    const destination = ctx.createMediaStreamDestination()
    this.source.connect(node).connect(destination)

    const output = destination.stream.getAudioTracks()[0]
    if (!output) throw new Error('no processed audio track')
    this.output = output
    return output
  }

  stop(): void {
    this.stopped = true
    this.output?.stop()
    this.output = null
    this.source?.disconnect()
    this.source = null
    if (this.node) {
      this.node.disconnect()
      this.node.destroy()
      // Chromium doesn't collect worklet nodes whose port is still open.
      this.node.port.close()
    }
    this.node = null
    void this.ctx?.close().catch(() => {})
    this.ctx = null
  }

  private fail(): void {
    if (this.stopped) return
    this.stop()
    this.onFailure()
  }
}

// Browsers slow a page's setInterval to once a second in background tabs, and
// to once a minute after five minutes. A worker's timers aren't throttled the
// same way, so effects driven by this keep running while you're in another tab.
const SOURCE = 'let t = null; onmessage = (e) => { clearInterval(t); if (e.data > 0) t = setInterval(() => postMessage(0), e.data) }'

/** Calls `tick` every `intervalMs` until the returned stop runs. */
export function startWorkerClock(intervalMs: number, tick: () => void): () => void {
  let worker: Worker | null = null
  let url: string | null = null
  try {
    url = URL.createObjectURL(new Blob([SOURCE], { type: 'text/javascript' }))
    worker = new Worker(url)
    worker.onmessage = tick
    worker.postMessage(intervalMs)
  } catch {
    // No workers here: the page's timer still works, just slower in the background.
    if (url) URL.revokeObjectURL(url)
    const timer = setInterval(tick, intervalMs)
    return () => clearInterval(timer)
  }
  return () => {
    worker?.terminate()
    if (url) URL.revokeObjectURL(url)
  }
}

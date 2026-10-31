import { Children, isValidElement, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

interface VideoGridProps {
  children: ReactNode
  gap?: number
  /** Width / height of a tile. */
  tileAspect?: number
  /** The key of the child to show large, with the rest in a strip below. */
  focusKey?: string | null
}

interface Layout {
  cols: number
  rows: number
  tileWidth: number
  tileHeight: number
}

const EMPTY: Layout = { cols: 1, rows: 1, tileWidth: 0, tileHeight: 0 }

/**
 * Tries every column count and keeps the one with the largest tile. Fixed
 * breakpoints can't fit 5 people into both a wide window and an upright phone.
 */
export function computeLayout(count: number, width: number, height: number, gap: number, tileAspect: number): Layout {
  if (count <= 0 || width <= 0 || height <= 0) return EMPTY
  const portrait = height > width

  let best: Layout | null = null
  let bestArea = 0
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols)
    const availW = width - gap * (cols - 1)
    const availH = height - gap * (rows - 1)
    if (availW <= 0 || availH <= 0) continue

    let tileWidth: number
    let tileHeight: number
    if (portrait) {
      // Rows take the full height, so one or two people fill an upright phone.
      tileHeight = Math.floor(availH / rows)
      tileWidth = Math.min(Math.floor(availW / cols), Math.floor(tileHeight * tileAspect))
    } else {
      tileWidth = Math.floor(Math.min(availW / cols, (availH / rows) * tileAspect))
      tileHeight = Math.floor(tileWidth / tileAspect)
    }

    // In portrait a row can be far taller than the 16:9 picture inside it.
    // Comparing row heights would pick 3 narrow columns over 3 stacked rows,
    // so compare the height the picture actually takes.
    const visibleHeight = portrait ? Math.min(tileHeight, Math.floor(tileWidth / tileAspect)) : tileHeight
    const area = tileWidth * visibleHeight
    if (area > bestArea) {
      bestArea = area
      best = { cols, rows, tileWidth, tileHeight }
    }
  }
  return best ?? EMPTY
}

/**
 * Places each child at a computed position instead of letting CSS flow them,
 * so tiles glide when people come and go, and a tile's <video> is never
 * recreated when it moves.
 */
export function VideoGrid({ children, gap = 8, tileAspect = 16 / 9, focusKey }: VideoGridProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setSize({ w: r.width, h: r.height })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [])

  const kids: ReactElement[] = []
  Children.forEach(children, (child) => {
    if (isValidElement(child)) kids.push(child)
  })
  const count = kids.length
  const layout = useMemo(() => computeLayout(count, size.w, size.h, gap, tileAspect), [count, size.w, size.h, gap, tileAspect])

  const focusIndex = focusKey ? kids.findIndex((child) => String(child.key) === focusKey) : -1
  const thumbnails = kids.filter((_, index) => index !== focusIndex)
  const stripHeight = Math.min(100, size.h * 0.23)
  const thumbWidth = Math.min(160, Math.max(72, (size.w - gap * (thumbnails.length - 1)) / Math.max(1, thumbnails.length)))

  return (
    <div ref={ref} className="relative h-full w-full overflow-hidden">
      {kids.map((child, index) => {
        let left = 0
        let top = 0
        let width = size.w
        let height = size.h
        if (focusIndex >= 0) {
          if (index === focusIndex) {
            height = Math.max(0, size.h - stripHeight - gap)
          } else {
            const stripIndex = thumbnails.indexOf(child)
            width = thumbWidth
            height = stripHeight
            left = (size.w - (thumbWidth * thumbnails.length + gap * (thumbnails.length - 1))) / 2 + stripIndex * (thumbWidth + gap)
            top = size.h - stripHeight
          }
        } else {
          const row = Math.floor(index / layout.cols)
          // A short last row is centred.
          const rowCount = Math.min(layout.cols, count - row * layout.cols)
          width = layout.tileWidth
          height = layout.tileHeight
          left = (size.w - (rowCount * width + (rowCount - 1) * gap)) / 2 + (index % layout.cols) * (width + gap)
          top = (size.h - (layout.rows * height + (layout.rows - 1) * gap)) / 2 + row * (height + gap)
        }
        return (
          <div key={child.key ?? index} className="call-tile-position absolute" style={{ left, top, width, height }}>
            {child}
          </div>
        )
      })}
    </div>
  )
}

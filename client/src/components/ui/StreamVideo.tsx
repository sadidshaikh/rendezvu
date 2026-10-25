import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

interface StreamVideoProps {
  stream: MediaStream
  className?: string
}

/** Plays a stream silently. For our own camera: our own audio must never play back to us. */
export function StreamVideo({ stream, className }: StreamVideoProps) {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream
  }, [stream])

  return (
    <video ref={ref} autoPlay muted playsInline className={cn('absolute inset-0 h-full w-full object-cover', className)} />
  )
}

import { useRef } from 'react'
import { ImagePlus, Loader2 } from 'lucide-react'
import type { BackgroundEffect } from '@/lib/effects/preferences'
import { cn } from '@/lib/utils'
import { useMeetStore } from '@/stores/meet'
import { usePeerStore } from '@/stores/peer'

const OPTIONS: Array<{ effect: Exclude<BackgroundEffect, 'image'>; label: string }> = [
  { effect: 'off', label: 'Off' },
  { effect: 'blur-subtle', label: 'Subtle' },
  { effect: 'blur-medium', label: 'Medium' },
  { effect: 'blur-strong', label: 'Strong' },
]
// Big enough for any photo; bigger is almost certainly a mistake.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** Background and noise suppression. Saved for next time; applied at once if the device is on. */
export function EffectsSettings() {
  const effect = usePeerStore((s) => s.backgroundEffect)
  const imageUrl = usePeerStore((s) => s.backgroundImageUrl)
  const backgroundBusy = usePeerStore((s) => s.backgroundBusy)
  const noise = usePeerStore((s) => s.noiseSuppression)
  const noiseBusy = usePeerStore((s) => s.noiseBusy)
  const cameraOff = useMeetStore((s) => s.isVideoOff)
  const muted = useMeetStore((s) => s.isMuted)
  const fileInput = useRef<HTMLInputElement>(null)
  const store = usePeerStore.getState

  const choose = (next: BackgroundEffect) => {
    if (next !== effect) void store().setBackgroundEffect(next)
  }
  const pickImage = (file: File | undefined) => {
    if (!file) return
    if (file.size > MAX_IMAGE_BYTES) return
    void store().setBackgroundEffect('image', file)
  }

  const option = (selected: boolean) =>
    cn(
      'flex min-h-10 cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition-colors',
      'focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-wait disabled:opacity-60',
      selected ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-surface-2/60 text-foreground hover:bg-surface-2',
    )

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2.5" role="radiogroup" aria-label="Background">
        <span className="text-sm font-medium">Background</span>
        <div className="grid grid-cols-3 gap-2">
          {OPTIONS.map((o) => (
            <button
              key={o.effect}
              type="button"
              role="radio"
              aria-checked={effect === o.effect}
              disabled={backgroundBusy}
              onClick={() => choose(o.effect)}
              className={option(effect === o.effect)}
            >
              {backgroundBusy && effect === o.effect && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
              {o.label}
            </button>
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={effect === 'image'}
            disabled={backgroundBusy}
            onClick={() => fileInput.current?.click()}
            className={cn(option(effect === 'image'), 'col-span-2 overflow-hidden')}
            aria-label="Picture behind you"
          >
            {effect === 'image' && imageUrl ? (
              <img src={imageUrl} alt="" className="h-6 w-10 rounded object-cover" />
            ) : backgroundBusy && effect === 'image' ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <ImagePlus className="size-3.5" aria-hidden="true" />
            )}
            {effect === 'image' ? 'Change picture' : 'Picture'}
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            pickImage(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <p className="text-xs text-muted-foreground">
          {cameraOff ? 'Applies when your camera is on.' : 'Only your camera; a screen share is sent as it is.'} A picture lasts
          until you reload.
        </p>
      </div>

      <label className="flex cursor-pointer items-start justify-between gap-4">
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Noise suppression</span>
          <span className="text-xs text-muted-foreground">
            Removes typing, fans and background chatter from your microphone.{muted ? ' Applies when your mic is on.' : ''}
          </span>
        </span>
        <span className="relative mt-0.5 inline-flex shrink-0 items-center">
          <input
            type="checkbox"
            role="switch"
            className="peer sr-only"
            checked={noise}
            disabled={noiseBusy}
            onChange={(e) => void store().setNoiseSuppression(e.target.checked)}
          />
          <span
            aria-hidden="true"
            className="h-6 w-10 rounded-full bg-muted transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50 peer-disabled:opacity-60"
          />
          <span
            aria-hidden="true"
            className="absolute left-0.5 size-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4"
          />
          {noiseBusy && <Loader2 className="absolute -left-6 size-4 animate-spin text-muted-foreground" aria-hidden="true" />}
        </span>
      </label>
    </div>
  )
}

import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { useMediaDevices } from '@/hooks/use-media-devices'
import { usePeerStore } from '@/stores/peer'
import { ConnectionDiagnostics } from './ConnectionDiagnostics'
import { DevicePickers, hasAnyDevice } from './DevicePickers'
import { EffectsSettings } from './EffectsSettings'

interface SettingsPanelProps {
  onClose: () => void
  /** In a call: adds the Connection section. The lobby has no connections to show. */
  inCall?: boolean
}

/** Side panel for call settings: devices, effects, and in a call the connection details. */
export function SettingsPanel({ onClose, inCall = false }: SettingsPanelProps) {
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const localStream = usePeerStore((s) => s.localStream)
  const devices = useMediaDevices(localStream)

  // Focus moves into the panel on open and back to where it was on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panelRef.current?.querySelector<HTMLElement>('button')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [])

  return (
    <aside
      id="call-settings-panel"
      ref={panelRef}
      role="dialog"
      aria-label="Settings"
      className="call-stage fixed inset-y-0 right-0 z-[60] flex w-80 max-w-[90vw] flex-col border-l border-border bg-[hsl(var(--surface)/0.98)] shadow-2xl backdrop-blur-xl"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-[hsl(var(--border)/0.5)] px-5 py-4">
        <span className="text-sm font-semibold">Settings</span>
        <button type="button" onClick={onClose} aria-label="Close settings" className="ctrl-btn ctrl-btn-on h-7 w-7">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-7 overflow-y-auto px-5 py-6">
        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">Devices</h2>
          {hasAnyDevice(devices) ? (
            <DevicePickers devices={devices} idPrefix="settings" layout="stack" />
          ) : (
            <p className="rounded-xl border border-[hsl(var(--border)/0.4)] bg-surface-2/60 px-4 py-3 text-sm text-muted-foreground">
              Turn on your microphone or camera to choose a device. Your browser lists them once you’ve allowed access.
            </p>
          )}
        </section>
        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">Effects</h2>
          <EffectsSettings />
        </section>
        {inCall && (
          <section className="flex flex-col gap-3">
            <h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">Connection</h2>
            <ConnectionDiagnostics />
          </section>
        )}
      </div>
    </aside>
  )
}

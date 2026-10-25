import type { MediaDeviceSummary } from '@/hooks/use-media-devices'
import { cn } from '@/lib/utils'
import { Select } from './select'

interface DeviceSelectProps {
  label: string
  devices: MediaDeviceSummary[]
  /** The saved choice, or '' for none. */
  value: string
  /** The device actually in use, shown when the saved one isn't available. */
  currentId?: string
  onChange: (deviceId: string) => void
  id?: string
  className?: string
}

export function DeviceSelect({ label, devices, value, currentId, onChange, id, className }: DeviceSelectProps) {
  if (devices.length === 0) return null
  const has = (deviceId?: string) => !!deviceId && devices.some((d) => d.deviceId === deviceId)
  const selected = has(value) ? value : has(currentId) ? currentId : devices[0]?.deviceId

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <Select id={id} value={selected} onChange={(e) => onChange(e.target.value)}>
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label}
          </option>
        ))}
      </Select>
    </div>
  )
}

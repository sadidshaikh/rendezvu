import { Button } from './button'

interface DeviceErrorNoticeProps {
  message: string
  onSettings: () => void
  onDismiss: () => void
}

export function DeviceErrorNotice({ message, onSettings, onDismiss }: DeviceErrorNoticeProps) {
  return (
    <div role="alert" className="my-2 rounded-lg border border-destructive/30 bg-surface p-3 text-sm">
      <p>{message}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onSettings}>
          Open device settings
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}

export type MediaKind = 'mic' | 'camera'

/** Why a device couldn't be opened, in words a user can act on. */
export function describeMediaError(kind: MediaKind, error: unknown): string {
  const device = kind === 'mic' ? 'microphone' : 'camera'
  const Device = kind === 'mic' ? 'Microphone' : 'Camera'

  if (!navigator.mediaDevices?.getUserMedia) {
    return `${Device} access needs a secure (HTTPS) connection.`
  }

  switch (error instanceof DOMException ? error.name : '') {
    case 'NotAllowedError':
    case 'SecurityError':
      return `${Device} access is blocked. Allow it in your browser’s site settings, then try again.`
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `No ${device} found. Connect one, or choose another in settings.`
    case 'NotReadableError':
    case 'AbortError':
      return `Your ${device} is in use by another app, or couldn’t start. Close other apps that use it, then try again.`
    default:
      return `${Device} unavailable. Allow access in your browser’s site settings, or choose another device in settings.`
  }
}

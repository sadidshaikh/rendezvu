const STORAGE_KEY = 'rendezvu:devices'

export interface DevicePrefs {
  audioInputId?: string
  videoInputId?: string
  audioOutputId?: string
}

export function getDevicePreferences(): DevicePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as DevicePrefs) : {}
  } catch {
    return {}
  }
}

export function setDevicePreference(key: keyof DevicePrefs, deviceId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...getDevicePreferences(), [key]: deviceId }))
  } catch {
    /* non-critical */
  }
}

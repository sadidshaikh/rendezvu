export type BackgroundEffect = 'off' | 'blur-subtle' | 'blur-medium' | 'blur-strong' | 'image'

export interface EffectPreferences {
  /** Never 'image': a picture is too big for localStorage, so it lasts one page. */
  background: Exclude<BackgroundEffect, 'image'>
  noiseSuppression: boolean
}

const KEY = 'rendezvu.effects'
const DEFAULTS: EffectPreferences = { background: 'off', noiseSuppression: false }
const SAVED_BACKGROUNDS = new Set<EffectPreferences['background']>(['off', 'blur-subtle', 'blur-medium', 'blur-strong'])

export function readEffectPreferences(): EffectPreferences {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<EffectPreferences>
    return {
      background: raw.background && SAVED_BACKGROUNDS.has(raw.background) ? raw.background : DEFAULTS.background,
      noiseSuppression: raw.noiseSuppression === true,
    }
  } catch {
    return DEFAULTS
  }
}

export function saveEffectPreferences(update: Partial<{ background: BackgroundEffect; noiseSuppression: boolean }>): void {
  try {
    const next = { ...readEffectPreferences(), ...update }
    // A picture is saved as off: next time there's no picture to show.
    if (next.background === 'image') next.background = 'off'
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Storage blocked: the choice lasts this page.
  }
}

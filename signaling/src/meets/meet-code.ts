import { randomBytes } from 'node:crypto'

// No l, o, 0 or 1, so a code read aloud or typed from a screenshot can't be
// misread. Exactly 32 characters: 256 divides evenly by 32, so byte % 32
// picks every character with equal probability.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

export const MEET_CODE_PATTERN = /^[a-z2-9]{3}-[a-z2-9]{4}-[a-z2-9]{3}$/

/** A fresh code shaped abc-defg-hij (32^10 ≈ 10^15 possibilities). */
export function generateMeetCode(): string {
  const chars = [...randomBytes(10)].map((b) => ALPHABET[b % ALPHABET.length])
  return `${chars.slice(0, 3).join('')}-${chars.slice(3, 7).join('')}-${chars.slice(7).join('')}`
}

export function isMeetCode(value: unknown): value is string {
  return typeof value === 'string' && MEET_CODE_PATTERN.test(value)
}

import { join } from 'node:path'
import { readObject, writeObject } from './common'
import { isNewer, isStable } from './version'

// <userData>/update.json: what the last checks saw. The launcher's notice reads it too.
export interface CheckState {
  latest: string | null
  /** When `latest` was first seen. */
  latestAt: number
  /** The version people are told about. */
  announced: string | null
  attemptedAt: number
  attemptFailed: boolean
  /** The last update could not finish after Stage quit for it. */
  updateFailed: boolean
}

const HOUR = 60 * 60 * 1000
export const CONFIRM_AFTER_MS = HOUR
const RETRY_AFTER_MS = HOUR
const CHECK_EVERY_MS = 24 * HOUR

const file = (userData: string) => join(userData, 'update.json')

export function readCheck(userData: string): CheckState {
  const s = readObject(file(userData))
  const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    latest: isStable(s.latest) ? s.latest : null,
    latestAt: time(s.latestAt),
    announced: isStable(s.announced) ? s.announced : null,
    attemptedAt: time(s.attemptedAt),
    attemptFailed: s.attemptFailed === true,
    updateFailed: s.updateFailed === true,
  }
}

export function saveCheck(userData: string, change: Partial<CheckState>): CheckState {
  const next = { ...readCheck(userData), ...change }
  try {
    writeObject(file(userData), next)
  } catch (e) {
    console.error('[stage] could not write update.json', e)
  }
  return next
}

/**
 * A new version is announced on its second sighting, an hour after the first, so a release that is
 * pulled straight away is never offered. Asking by hand announces at once.
 */
export function afterSighting(s: CheckState, latest: string, current: string, now: number, byHand: boolean): CheckState {
  const next = { ...s, attemptedAt: now, attemptFailed: false }
  // The version that is running is announced too, for older copies of Stage that share this profile.
  if (!isNewer(latest, current)) return { ...next, latest, latestAt: now, announced: latest === current ? latest : null }
  const firstSighting = s.latest !== latest || s.latestAt > now
  const confirmed = byHand || (!firstSighting && now - s.latestAt >= CONFIRM_AFTER_MS)
  // An older announcement stands until the newer one is confirmed, unless it has been pulled.
  const standing = s.announced && !isNewer(s.announced, latest) ? s.announced : null
  return { ...next, latest, latestAt: firstSighting ? now : s.latestAt, announced: confirmed ? latest : standing }
}

export function isDue(s: CheckState, current: string, now: number): boolean {
  const elapsed = now - s.attemptedAt
  if (elapsed < 0) return true // the clock went back
  if (s.attemptFailed) return elapsed >= RETRY_AFTER_MS
  const unconfirmed = !!s.latest && s.latest !== s.announced && isNewer(s.latest, current)
  return elapsed >= (unconfirmed ? CONFIRM_AFTER_MS : CHECK_EVERY_MS)
}

export const availableVersion = (s: CheckState, current: string): string | null => (s.announced && isNewer(s.announced, current) ? s.announced : null)

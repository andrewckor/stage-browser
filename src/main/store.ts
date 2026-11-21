import { app, type Rectangle } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Prefs {
  hideExtensionIcons: boolean
}

export interface SavedSession {
  tabs: string[]
  active: number
  pinned: boolean
  bounds?: Rectangle | undefined
}

export interface HistoryEntry {
  url: string
  title: string
  visits: number
  last: number
}

const file = (name: string) => join(app.getPath('userData'), name)

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file(name), 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(name: string, data: unknown): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    const tmp = file(name) + '.tmp'
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, file(name))
  } catch (e) {
    console.error('[stage] write failed', name, e)
  }
}

export const readPrefs = (): Prefs => ({ hideExtensionIcons: false, ...readJson<Partial<Prefs>>('prefs.json', {}) })
export const writePrefs = (prefs: Prefs) => writeJson('prefs.json', prefs)
export const readSession = (): Partial<SavedSession> => readJson<Partial<SavedSession>>('session.json', {})
export const writeSession = (session: SavedSession) => writeJson('session.json', session)

const HISTORY_CAP = 2000
let history: Map<string, HistoryEntry> | null = null
let historyTimer: ReturnType<typeof setTimeout> | undefined

function loadHistory(): Map<string, HistoryEntry> {
  if (history) return history
  history = new Map()
  for (const h of readJson<HistoryEntry[]>('history.json', [])) if (h?.url) history.set(h.url, h)
  return history
}

export function addVisit(url: string, title: string): void {
  const h = loadHistory()
  const e = h.get(url) ?? { url, title: '', visits: 0, last: 0 }
  e.visits++
  e.last = Date.now()
  if (title) e.title = title
  h.delete(url)
  h.set(url, e)
  if (h.size > HISTORY_CAP) {
    const recent = [...h.values()].sort((a, b) => b.last - a.last).slice(0, HISTORY_CAP)
    history = new Map(recent.map((x) => [x.url, x]))
  }
  scheduleHistorySave()
}

export function setHistoryTitle(url: string, title: string): void {
  const e = loadHistory().get(url)
  if (e && title && e.title !== title) {
    e.title = title
    scheduleHistorySave()
  }
}

function scheduleHistorySave(): void {
  clearTimeout(historyTimer)
  historyTimer = setTimeout(flushHistory, 2000)
}

export function flushHistory(): void {
  clearTimeout(historyTimer)
  historyTimer = undefined
  if (history) writeJson('history.json', [...history.values()])
}

export function historyEntries(): HistoryEntry[] {
  return [...loadHistory().values()]
}

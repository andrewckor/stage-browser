import type { Suggestion } from '../shared/contract'
import { historyEntries } from './store'
import type { Tab } from './tabs'
import { classify } from './url'

const MAX = 8
const DAY_MS = 86_400_000

export function suggest(tabs: readonly Tab[], query: string): Suggestion[] {
  const q = query.trim()
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = (s: string) => {
    const l = s.toLowerCase()
    return words.every((w) => l.includes(w))
  }
  const out: Suggestion[] = []
  const seen = new Set<string>()

  const first = classify(q)
  if (first) {
    out.push({ kind: first.kind, title: first.kind === 'search' ? `Search Google for “${q}”` : first.url, url: first.url, favicon: null })
    seen.add(first.url)
  }

  for (const t of tabs) {
    if (out.length >= MAX) break
    if (!t.url || (words.length && !matches(`${t.title} ${t.url}`))) continue
    out.push({ kind: 'tab', title: t.title || t.url, url: t.url, tabId: t.id, favicon: t.favicon })
    seen.add(t.url)
  }

  if (words.length) {
    const now = Date.now()
    const scored = historyEntries()
      .filter((h) => !seen.has(h.url) && matches(`${h.title} ${h.url}`))
      .map((h) => ({ h, score: h.visits + Math.max(0, 7 - (now - h.last) / DAY_MS) }))
      .sort((a, b) => b.score - a.score)
    for (const { h } of scored) {
      if (out.length >= MAX) break
      out.push({ kind: 'history', title: h.title || h.url, url: h.url, favicon: null })
    }
  }
  return out.slice(0, MAX)
}

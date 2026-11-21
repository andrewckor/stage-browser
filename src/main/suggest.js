'use strict'
const store = require('./store')
const { classify } = require('./url')

const MAX = 8

function suggest(ctx, query) {
  const q = String(query || '').trim()
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = (s) => {
    const l = s.toLowerCase()
    return words.every((w) => l.includes(w))
  }
  const out = []
  const seen = new Set()

  const first = classify(q)
  if (first) {
    out.push({
      kind: first.kind,
      title: first.kind === 'search' ? `Search Google for “${q}”` : first.url,
      url: first.url,
    })
    seen.add(first.url)
  }

  for (const t of ctx.tabs.list) {
    if (out.length >= MAX) break
    if (!t.url) continue
    if (words.length && !matches(`${t.title} ${t.url}`)) continue
    out.push({ kind: 'tab', title: t.title || t.url, url: t.url, tabId: t.id, favicon: t.favicon })
    seen.add(t.url)
  }

  if (words.length) {
    const now = Date.now()
    const scored = store
      .historyEntries()
      .filter((h) => !seen.has(h.url) && matches(`${h.title} ${h.url}`))
      .map((h) => ({ h, score: h.visits + Math.max(0, 7 - (now - h.last) / 86400000) }))
      .sort((a, b) => b.score - a.score)
    for (const { h } of scored) {
      if (out.length >= MAX) break
      out.push({ kind: 'history', title: h.title || h.url, url: h.url, favicon: null })
    }
  }
  return out.slice(0, MAX)
}

module.exports = { suggest }

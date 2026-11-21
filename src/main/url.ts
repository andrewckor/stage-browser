const SCHEME_SLASHES = /^[a-z][a-z0-9+.-]*:\/\//i
const SCHEME_BARE = /^(about|data|mailto|view-source|blob|chrome-extension|file):/i
const LOCAL = /^(localhost|\[[0-9a-f:]+\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i
const DOTTED = /^[^\s/?#:]+\.[a-z][a-z0-9-]*(:\d+)?([/?#]\S*)?$/i
const SEARCH_PREFIX = 'https://www.google.com/search?q='

export type InputKind = 'search' | 'url'

export function searchUrl(query: string): string {
  return SEARCH_PREFIX + encodeURIComponent(query)
}

export function resolveInput(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  if (SCHEME_SLASHES.test(s) || SCHEME_BARE.test(s)) return s
  if (!/\s/.test(s)) {
    if (LOCAL.test(s)) return 'http://' + s
    if (DOTTED.test(s)) return 'https://' + s
  }
  return searchUrl(s)
}

export function classify(input: string): { url: string; kind: InputKind } | null {
  const s = input.trim()
  const url = resolveInput(s)
  if (url === null) return null
  return { url, kind: url.startsWith(SEARCH_PREFIX) && !s.startsWith('http') ? 'search' : 'url' }
}

export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

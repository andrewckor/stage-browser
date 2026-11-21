'use strict'
// Omnibox input -> URL. Pure functions, no Electron dependency.

const SCHEME_SLASHES = /^[a-z][a-z0-9+.-]*:\/\//i
const SCHEME_BARE = /^(about|data|mailto|view-source|blob|chrome-extension|file):/i
const LOCAL = /^(localhost|\[[0-9a-f:]+\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i
const DOTTED = /^[^\s/?#:]+\.[a-z][a-z0-9-]*(:\d+)?([/?#]\S*)?$/i

function searchUrl(q) {
  return 'https://www.google.com/search?q=' + encodeURIComponent(q)
}

function resolveInput(input) {
  const s = String(input == null ? '' : input).trim()
  if (!s) return null
  if (SCHEME_SLASHES.test(s) || SCHEME_BARE.test(s)) return s
  if (!/\s/.test(s)) {
    if (LOCAL.test(s)) return 'http://' + s
    if (DOTTED.test(s)) return 'https://' + s
  }
  return searchUrl(s)
}

// What kind of suggestion does the raw input produce?
function classify(input) {
  const s = String(input || '').trim()
  if (!s) return null
  const url = resolveInput(s)
  const isSearch = url.startsWith('https://www.google.com/search?q=') && !s.startsWith('http')
  return { url, kind: isSearch ? 'search' : 'url' }
}

function isWebUrl(u) {
  return /^https?:\/\//i.test(u || '')
}

module.exports = { resolveInput, classify, searchUrl, isWebUrl }

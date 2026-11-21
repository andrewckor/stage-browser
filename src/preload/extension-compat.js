'use strict'
// Fills gaps between electron-chrome-extensions and real Chrome. Runs after the library's own
// preload, in extension pages and service workers only.
//
// 1. Constants the library leaves undefined (chrome.tabs.TAB_ID_NONE and friends). The Okta
//    Browser Plugin builds a declarativeNetRequest rule with `tabIds: [chrome.tabs.TAB_ID_NONE]`;
//    with it undefined, its service worker throws at startup and its popup renders blank.
//
// 2. URL filters on chrome.webNavigation events. The library ignores the second argument of
//    addListener, so a listener meant for one URL pattern hears every navigation, iframes
//    included. Okta listens for Okta Personal app-launch URLs this way; without the filter, any
//    tracker iframe whose URL contains a UUID made it take over the tab and show "Sign in Error".
const { contextBridge } = require('electron')

// Serialized into the extension's main world, so everything it uses must live inside it.
function patchExtensionApis() {
  const c = globalThis.chrome
  if (!c) return

  const define = (obj, key, value) => {
    if (!obj || obj[key] !== undefined) return
    try {
      Object.defineProperty(obj, key, { value, enumerable: true })
    } catch {}
  }
  define(c.tabs, 'TAB_ID_NONE', -1)
  define(c.tabs, 'TAB_INDEX_NONE', -1)
  define(c.tabs, 'MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND', 2)
  define(c.windows, 'WINDOW_ID_NONE', -1)
  define(c.windows, 'WINDOW_ID_CURRENT', -2)

  // Chrome exposes `browser` as the same object as `chrome`. Electron has its own, smaller
  // `browser` without the APIs the library adds (windows, action, ...). 1Password reads
  // `browser.windows.WINDOW_ID_NONE` at startup, so its service worker crashed and its popup
  // spun forever.
  if (globalThis.browser !== c) {
    try {
      Object.defineProperty(globalThis, 'browser', { value: c, configurable: true, writable: true })
    } catch {
      const b = globalThis.browser
      if (b) {
        for (const key of Object.keys(c)) {
          if (b[key] === c[key]) continue
          try {
            Object.defineProperty(b, key, { value: c[key], configurable: true, writable: true, enumerable: true })
          } catch {}
        }
      }
    }
  }

  // chrome.events.UrlFilter: every condition in one filter must hold; any filter in the list may match.
  const DEFAULT_PORTS = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443, 'ftp:': 21 }
  const regexCache = new Map()
  const regex = (source) => {
    if (!regexCache.has(source)) {
      let re = null
      try {
        re = new RegExp(source)
      } catch {}
      regexCache.set(source, re)
    }
    return regexCache.get(source)
  }
  const matchesFilter = (rawUrl, f) => {
    let u
    try {
      u = new URL(rawUrl)
    } catch {
      return false
    }
    u.hash = ''
    const url = u.href // default ports are already dropped by the URL parser
    const host = u.hostname
    const path = u.pathname
    const query = u.search.replace(/^\?/, '')
    const port = u.port ? Number(u.port) : DEFAULT_PORTS[u.protocol]
    const checks = {
      hostContains: (v) => ('.' + host).includes(v),
      hostEquals: (v) => host === v,
      hostPrefix: (v) => host.startsWith(v),
      hostSuffix: (v) => host.endsWith(v),
      pathContains: (v) => path.includes(v),
      pathEquals: (v) => path === v,
      pathPrefix: (v) => path.startsWith(v),
      pathSuffix: (v) => path.endsWith(v),
      queryContains: (v) => query.includes(v),
      queryEquals: (v) => query === v,
      queryPrefix: (v) => query.startsWith(v),
      querySuffix: (v) => query.endsWith(v),
      urlContains: (v) => url.includes(v),
      urlEquals: (v) => url === v,
      urlPrefix: (v) => url.startsWith(v),
      urlSuffix: (v) => url.endsWith(v),
      urlMatches: (v) => !!regex(v) && regex(v).test(url),
      originAndPathMatches: (v) => !!regex(v) && regex(v).test(u.origin + path),
      schemes: (v) => Array.isArray(v) && v.includes(u.protocol.replace(/:$/, '')),
      ports: (v) => Array.isArray(v) && v.some((p) => (Array.isArray(p) ? port >= p[0] && port <= p[1] : port === p)),
    }
    return Object.keys(f).every((key) => (checks[key] ? checks[key](f[key]) : true))
  }
  const passes = (details, filter) => {
    const list = filter && Array.isArray(filter.url) ? filter.url : null
    if (!list || list.length === 0) return true
    return !!details && typeof details.url === 'string' && list.some((f) => matchesFilter(details.url, f))
  }

  const wn = c.webNavigation
  if (wn) {
    for (const name of Object.keys(wn)) {
      const ev = wn[name]
      if (!ev || typeof ev.addListener !== 'function' || ev.__stageFiltered) continue
      const add = ev.addListener.bind(ev)
      const remove = ev.removeListener.bind(ev)
      const wrappers = new Map()
      try {
        Object.defineProperties(ev, {
          __stageFiltered: { value: true },
          addListener: {
            value(callback, filter) {
              if (typeof callback !== 'function' || wrappers.has(callback)) return
              const wrapper = (details, ...rest) => {
                if (passes(details, filter)) return callback(details, ...rest)
              }
              wrappers.set(callback, wrapper)
              add(wrapper)
            },
          },
          removeListener: {
            value(callback) {
              const wrapper = wrappers.get(callback)
              if (!wrapper) return
              wrappers.delete(callback)
              remove(wrapper)
            },
          },
          hasListener: { value: (callback) => wrappers.has(callback) },
          hasListeners: { value: () => wrappers.size > 0 },
        })
      } catch {}
    }
  }
}

const isExtensionContext = process.type === 'service-worker' || (typeof location !== 'undefined' && location.href.startsWith('chrome-extension://'))
if (isExtensionContext) {
  try {
    contextBridge.executeInMainWorld({ func: patchExtensionApis })
  } catch (e) {
    console.error('[stage] extension-compat preload failed', e)
  }
}

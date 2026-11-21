// Fills gaps between electron-chrome-extensions and real Chrome. Runs after the library's own
// preload, in extension pages and service workers only.
//
// 1. Constants the library leaves undefined (chrome.tabs.TAB_ID_NONE and friends). The Okta
//    Browser Plugin builds a declarativeNetRequest rule with `tabIds: [chrome.tabs.TAB_ID_NONE]`;
//    left undefined, its service worker throws at startup and its popup renders blank.
//
// 2. URL filters on chrome.webNavigation events. The library ignores the second argument of
//    addListener, so a listener meant for one URL pattern hears every navigation, iframes
//    included. Okta listens for Okta Personal app-launch URLs this way; without the filter, any
//    tracker iframe whose URL contains a UUID made it take over the tab and show "Sign in Error".
//
// A script, not a module: sandboxed and service-worker preloads have no `exports`.
{
  const { contextBridge }: typeof import('electron') = require('electron')

  // Serialized into the extension's main world, so everything it uses must live inside it.
  const patchExtensionApis = (): void => {
    type Bag = Record<string, unknown>
    type Listener = (details: unknown, ...rest: unknown[]) => unknown
    type PortRange = number | [min: number, max: number]
    interface UrlFilter {
      hostContains?: string
      hostEquals?: string
      hostPrefix?: string
      hostSuffix?: string
      pathContains?: string
      pathEquals?: string
      pathPrefix?: string
      pathSuffix?: string
      queryContains?: string
      queryEquals?: string
      queryPrefix?: string
      querySuffix?: string
      urlContains?: string
      urlEquals?: string
      urlPrefix?: string
      urlSuffix?: string
      urlMatches?: string
      originAndPathMatches?: string
      schemes?: string[]
      ports?: PortRange[]
    }
    interface EventFilter {
      url?: UrlFilter[]
    }
    interface ChromeEvent {
      addListener(callback: Listener, filter?: EventFilter): void
      removeListener(callback: Listener): void
      __stageFiltered?: true
    }
    type Checks = { [K in keyof UrlFilter]-?: (value: NonNullable<UrlFilter[K]>) => boolean }

    const g = globalThis as unknown as { chrome?: Bag; browser?: Bag }
    const c = g.chrome
    if (!c) return

    const define = (target: unknown, key: string, value: unknown) => {
      if (!target || typeof target !== 'object' || (target as Bag)[key] !== undefined) return
      try {
        Object.defineProperty(target, key, { value, enumerable: true })
      } catch {}
    }
    define(c.tabs, 'TAB_ID_NONE', -1)
    define(c.tabs, 'TAB_INDEX_NONE', -1)
    define(c.tabs, 'MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND', 2)
    define(c.windows, 'WINDOW_ID_NONE', -1)
    define(c.windows, 'WINDOW_ID_CURRENT', -2)

    // Chrome exposes `browser` as the same object as `chrome`. Electron has its own, smaller
    // `browser` without the APIs the library adds. 1Password reads `browser.windows.WINDOW_ID_NONE`
    // at startup, so its service worker crashed and its popup spun forever.
    if (g.browser !== c) {
      try {
        Object.defineProperty(globalThis, 'browser', { value: c, configurable: true, writable: true })
      } catch {
        const b = g.browser
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
    const DEFAULT_PORTS: Partial<Record<string, number>> = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443, 'ftp:': 21 }
    const regexCache = new Map<string, RegExp | null>()
    const regex = (source: string): RegExp | null => {
      if (!regexCache.has(source)) {
        let re: RegExp | null = null
        try {
          re = new RegExp(source)
        } catch {}
        regexCache.set(source, re)
      }
      return regexCache.get(source) ?? null
    }

    const matchesFilter = (rawUrl: string, filter: UrlFilter): boolean => {
      let u: URL
      try {
        u = new URL(rawUrl)
      } catch {
        return false
      }
      u.hash = ''
      const url = u.href // the URL parser already drops default ports
      const host = u.hostname
      const path = u.pathname
      const query = u.search.replace(/^\?/, '')
      const port = u.port ? Number(u.port) : DEFAULT_PORTS[u.protocol]
      const checks: Checks = {
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
        urlMatches: (v) => !!regex(v)?.test(url),
        originAndPathMatches: (v) => !!regex(v)?.test(u.origin + path),
        schemes: (v) => Array.isArray(v) && v.includes(u.protocol.replace(/:$/, '')),
        ports: (v) => Array.isArray(v) && port !== undefined && v.some((p) => (Array.isArray(p) ? port >= p[0] && port <= p[1] : port === p)),
      }
      const lookup = checks as Partial<Record<string, (value: unknown) => boolean>>
      return Object.entries(filter).every(([key, value]) => lookup[key]?.(value) ?? true)
    }

    const passes = (details: unknown, filter: EventFilter | undefined): boolean => {
      const list = Array.isArray(filter?.url) ? filter.url : null
      if (!list?.length) return true
      const url = details && typeof details === 'object' ? (details as { url?: unknown }).url : undefined
      return typeof url === 'string' && list.some((f) => matchesFilter(url, f))
    }

    const nav = c.webNavigation as Partial<Record<string, ChromeEvent>> | undefined
    if (!nav) return
    for (const ev of Object.values(nav)) {
      if (!ev || typeof ev.addListener !== 'function' || ev.__stageFiltered) continue
      const add = ev.addListener.bind(ev)
      const remove = ev.removeListener.bind(ev)
      const wrappers = new Map<Listener, Listener>()
      try {
        Object.defineProperties(ev, {
          __stageFiltered: { value: true },
          addListener: {
            value(callback: Listener, filter?: EventFilter) {
              if (typeof callback !== 'function' || wrappers.has(callback)) return
              const wrapper: Listener = (details, ...rest) => (passes(details, filter) ? callback(details, ...rest) : undefined)
              wrappers.set(callback, wrapper)
              add(wrapper)
            },
          },
          removeListener: {
            value(callback: Listener) {
              const wrapper = wrappers.get(callback)
              if (!wrapper) return
              wrappers.delete(callback)
              remove(wrapper)
            },
          },
          hasListener: { value: (callback: Listener) => wrappers.has(callback) },
          hasListeners: { value: () => wrappers.size > 0 },
        })
      } catch {}
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
}

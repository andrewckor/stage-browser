// A fake window.stage for previewing the UI in a plain browser. app.js loads it only when
// window.stage is undefined, which never happens inside Electron.
//
// URL params:
//   scene     bar | single | many | loading | pinned | omnibox | omnibox-edit | newtab
//   theme     dark | light
//   backdrop  light | dark       paints a fake web page behind the transparent UI
//   layout    top | left | right   tab bar position (default top)
//   anim      0                  disables transitions, for deterministic screenshots
//   visible   0                  starts with the bar hidden
//   selfcheck main | many        runs in-page interaction checks; results land in #selfcheck
{
  type StageApi = import('../shared/contract').StageApi
  type StageState = import('../shared/contract').StageState
  type TabSnapshot = import('../shared/contract').TabSnapshot
  type TabId = import('../shared/contract').TabId
  type OmniboxMode = import('../shared/contract').OmniboxMode
  type Suggestion = import('../shared/contract').Suggestion
  type UiCommands = import('../shared/contract').UiCommands

  type Call = { [K in keyof UiCommands]: [K, ...UiCommands[K]] }[keyof UiCommands] | ['suggest', string]
  type CallName = Call[0]
  type CallOf<K extends CallName> = Extract<Call, [K, ...unknown[]]>

  interface Page {
    title: string
    url: string
    favicon: string | null
    audible?: boolean
  }

  const params = new URLSearchParams(location.search)
  const scene = params.get('scene') ?? 'bar'
  const root = document.documentElement
  const theme = params.get('theme')
  if (theme) root.dataset.theme = theme

  const fav = (letter: string, bg: string, shape: 'square' | 'circle' = 'square'): string => {
    const inner = shape === 'circle' ? `<circle cx="8" cy="8" r="8" fill="${bg}"/>` : `<rect width="16" height="16" rx="4" fill="${bg}"/>`
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${inner}` +
      `<text x="8" y="11.6" font-family="-apple-system,Helvetica,Arial" font-size="10" font-weight="700" text-anchor="middle" fill="#fff">${letter}</text></svg>`
    return `data:image/svg+xml,${encodeURIComponent(svg)}`
  }

  const POOL: readonly Page[] = [
    { title: 'Workflow editor — Northwind', url: 'https://northwind.example/editor/2481', favicon: fav('N', '#2e6b5b') },
    { title: 'Pull request #482 · acme/stage', url: 'https://github.com/acme/stage/pull/482', favicon: fav('G', '#24292f', 'circle') },
    { title: 'Quarterly roadmap', url: 'https://notion.example.com/roadmap', favicon: null },
    { title: 'Design review — homepage v3', url: 'https://figma.example.com/file/abc', favicon: fav('F', '#7c3aed') },
    { title: 'Inbox (12)', url: 'https://mail.example.com/inbox', favicon: fav('M', '#2563eb') },
    { title: 'A very long page title that will certainly need to be truncated at the edge of the tab', url: 'https://docs.example.org/guides/long', favicon: null },
    { title: 'Webinar recording — lo-fi beats', url: 'https://music.example.com/live', favicon: fav('♪', '#db2777', 'circle'), audible: true },
    { title: 'Analytics — Overview', url: 'https://analytics.example.net/overview', favicon: null },
    { title: 'Customer interviews', url: 'https://sheets.example.com/d/1x', favicon: fav('S', '#16a34a') },
    { title: 'Staging — dashboard', url: 'https://staging.acme.dev/', favicon: null },
  ]

  const HISTORY: readonly Page[] = [
    { title: 'Northwind: Onboarding, automated', url: 'https://northwind.example/', favicon: fav('N', '#2e6b5b') },
    { title: 'Workflows — Northwind', url: 'https://northwind.example/app/workflows', favicon: fav('N', '#2e6b5b') },
    { title: 'Northwind docs', url: 'https://docs.northwind.example/', favicon: fav('N', '#2e6b5b') },
    { title: 'Electron — Build cross-platform apps', url: 'https://www.electronjs.org/', favicon: fav('E', '#2f3241', 'circle') },
    { title: 'Example Domain', url: 'https://example.com/', favicon: null },
    { title: 'Hacker News', url: 'https://news.ycombinator.com/', favicon: fav('Y', '#f26522') },
    { title: 'MDN Web Docs', url: 'https://developer.mozilla.org/', favicon: fav('M', '#111827') },
    { title: 'Calendar — this week', url: 'https://calendar.example.com/week', favicon: fav('C', '#0ea5e9') },
  ]

  let nextId = 100
  let nonce = 0
  const tab = (p: Page): TabSnapshot => ({ id: nextId++, title: p.title, url: p.url, favicon: p.favicon, loading: false, audible: !!p.audible, muted: false })
  const blank = (): TabSnapshot => tab({ title: 'New Tab', url: '', favicon: null })

  const pick = (n: number, silent: boolean): TabSnapshot[] =>
    Array.from({ length: n }, (_, i) => {
      const p = POOL[i % POOL.length] as Page
      const page = i < POOL.length ? p : { title: `${p.title.slice(0, 22)} ${Math.floor(i / POOL.length) + 1}`, url: `${p.url}?p=${i}`, favicon: p.favicon }
      const t = tab(page)
      if (silent) t.audible = false
      return t
    })

  const at = (tabs: TabSnapshot[], i: number): TabSnapshot => {
    const t = tabs[i]
    if (!t) throw new Error(`scene ${scene} has no tab ${i}`)
    return t
  }

  const sceneTabs = (): { tabs: TabSnapshot[]; active: number } => {
    switch (scene) {
      case 'single':
        return { tabs: pick(1, true), active: 0 }
      case 'newtab':
        return { tabs: [blank()], active: 0 }
      case 'many': {
        const tabs = pick(18, true)
        at(tabs, 6).audible = true
        return { tabs, active: 6 }
      }
      case 'loading': {
        const tabs = pick(6, false)
        Object.assign(at(tabs, 0), { loading: true, favicon: null })
        Object.assign(at(tabs, 3), { loading: true })
        Object.assign(at(tabs, 4), { audible: true, muted: true })
        tabs.push(tab(POOL[6] as Page))
        return { tabs, active: 0 }
      }
      case 'pinned':
        return { tabs: pick(5, true), active: 1 }
      default:
        return { tabs: [...pick(5, true), blank()], active: 1 }
    }
  }

  const layoutParam = params.get('layout')
  const layout = layoutParam === 'left' || layoutParam === 'right' ? layoutParam : 'top'
  const initial = sceneTabs()
  const st: StageState = {
    tabs: initial.tabs,
    activeTabId: at(initial.tabs, initial.active).id,
    canGoBack: true,
    canGoForward: false,
    zoomFactor: 1,
    bar: { visible: params.get('visible') !== '0', pinned: scene === 'pinned' },
    hideExtensionIcons: false,
    extensionActions: 2,
    overlay: null,
    barHeight: 52,
    tabLayout: layout,
    sidebarWidth: 248,
    fullscreen: false,
  }
  const omnibox = (mode: OmniboxMode, text: string) => ({ type: 'omnibox', mode, initial: text, nonce: ++nonce }) as const
  if (scene === 'omnibox') st.overlay = omnibox('new', 'zap')
  if (scene === 'omnibox-edit') st.overlay = omnibox('edit', at(st.tabs, 1).url)

  let listeners: ((s: StageState) => void)[] = []
  const calls: Call[] = []
  const record = (...call: Call): void => void calls.push(call)
  const snapshot = (): StageState => structuredClone(st)
  const emit = (): void => {
    const s = snapshot()
    for (const cb of listeners) cb(s)
  }
  const indexOf = (id: TabId): number => st.tabs.findIndex((t) => t.id === id)
  const activeTab = (): TabSnapshot | undefined => st.tabs.find((t) => t.id === st.activeTabId)

  const looksLikeUrl = (v: string): boolean => !/\s/.test(v) && (/^[a-z]+:\/\//i.test(v) || /^[^\s/]+\.[a-z]{2,}(\/|$)/i.test(v))
  const normalize = (v: string): string => (/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`)
  const hostOf = (u: string): string => {
    try {
      return new URL(u).hostname.replace(/^www\./, '')
    } catch {
      return u
    }
  }

  const makeSuggestions = (raw: string): Suggestion[] => {
    const q = raw.trim()
    const lq = q.toLowerCase()
    const matches = (p: { title: string; url: string }) => !q || p.title.toLowerCase().includes(lq) || p.url.toLowerCase().includes(lq)
    const out: Suggestion[] = []
    if (q) {
      out.push(
        looksLikeUrl(q)
          ? { kind: 'url', title: q, url: normalize(q), favicon: null }
          : { kind: 'search', title: `Search Google for “${q}”`, url: `https://www.google.com/search?q=${encodeURIComponent(q)}`, favicon: null },
      )
    }
    for (const t of st.tabs) {
      if ((t.id === st.activeTabId && !q) || !t.url || !matches(t)) continue
      out.push({ kind: 'tab', title: t.title, url: t.url, tabId: t.id, favicon: t.favicon })
    }
    for (const h of HISTORY) if (matches(h)) out.push({ kind: 'history', title: h.title, url: h.url, favicon: h.favicon })
    return out.slice(0, 8)
  }

  const api = {
    getState: () => Promise.resolve(snapshot()),
    onState: (cb) => {
      listeners.push(cb)
      return () => {
        listeners = listeners.filter((l) => l !== cb)
      }
    },
    activateTab: (id) => {
      record('activateTab', id)
      st.activeTabId = id
      emit()
    },
    closeTab: (id) => {
      record('closeTab', id)
      const i = indexOf(id)
      if (i < 0) return
      st.tabs.splice(i, 1)
      if (!st.tabs.length) {
        const b = blank()
        st.tabs.push(b)
        st.activeTabId = b.id
      } else if (st.activeTabId === id) st.activeTabId = at(st.tabs, Math.min(i, st.tabs.length - 1)).id
      emit()
    },
    moveTab: (id, to) => {
      record('moveTab', id, to)
      const i = indexOf(id)
      if (i < 0) return
      st.tabs.splice(to, 0, ...st.tabs.splice(i, 1))
      emit()
    },
    showTabMenu: (id) => record('showTabMenu', id),
    openOmnibox: (mode) => {
      record('openOmnibox', mode)
      st.overlay = omnibox(mode, mode === 'edit' ? (activeTab()?.url ?? '') : '')
      emit()
    },
    closeOverlay: () => {
      record('closeOverlay')
      st.overlay = null
      emit()
    },
    suggest: (q) => {
      record('suggest', q)
      return new Promise((resolve) => setTimeout(() => resolve(makeSuggestions(q)), q === 'sl' ? 160 : 20))
    },
    submitOmnibox: (text, options) => {
      record('submitOmnibox', text, options)
      const url = looksLikeUrl(text) ? normalize(text) : text
      const title = hostOf(url)
      if (options.newTab) {
        const t = tab({ title, url, favicon: null })
        st.tabs.push(t)
        st.activeTabId = t.id
      } else {
        const a = activeTab()
        if (a) Object.assign(a, { url, title, favicon: null })
      }
      st.overlay = null
      emit()
    },
    back: () => record('back'),
    forward: () => record('forward'),
    reload: () => record('reload'),
    setBarHover: (hovering) => record('setBarHover', hovering),
    passClick: (x, y, button, clickCount) => record('passClick', x, y, button, clickCount),
    startWindowDrag: () => record('startWindowDrag'),
    endWindowDrag: () => record('endWindowDrag'),
    windowAction: (action) => record('windowAction', action),
  } satisfies StageApi
  window.stage = api

  const mockCss = document.createElement('style')
  mockCss.textContent =
    'browser-action-list{display:flex}' +
    '.mock-action{width:24px;height:24px;margin:0 2px;border-radius:6px;display:grid;place-items:center}' +
    '.mock-action:hover{background:var(--hover)}' +
    '.mock-action i{width:16px;height:16px;border-radius:5px;background:linear-gradient(135deg,#8b5cf6,#6366f1);display:grid;place-items:center}' +
    '.mock-action svg{width:10px;height:10px}' +
    '#mock-page{position:fixed;inset:0;z-index:-1;overflow:hidden;font:15px/1.5 -apple-system,system-ui,sans-serif;-webkit-user-select:none}' +
    '#mock-page.light{background:#fff;color:#1a1a1a}#mock-page.dark{background:#0d1117;color:#e6edf3}' +
    '#mock-page nav{height:64px;display:flex;align-items:center;gap:28px;padding:0 32px;border-bottom:1px solid rgb(128 128 128/.2)}' +
    '#mock-page .logo{width:28px;height:28px;border-radius:8px;background:#ff4f00}' +
    '#mock-page.dark .logo{background:#2f81f7}' +
    '#mock-page nav b{font-weight:600}#mock-page nav span{opacity:.65;font-size:14px}' +
    '#mock-page nav .cta{margin-left:auto;padding:8px 16px;border-radius:8px;background:#ff4f00;color:#fff;font-weight:600;font-size:14px;opacity:1}' +
    '#mock-page.dark nav .cta{background:#238636}' +
    '#mock-page main{max-width:880px;margin:0 auto;padding:56px 32px}' +
    '#mock-page h1{font-size:44px;line-height:1.1;margin:0 0 16px;letter-spacing:-.03em}' +
    '#mock-page p{margin:0 0 12px;opacity:.72;max-width:640px}' +
    '#mock-page .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:32px}' +
    '#mock-page .card{border:1px solid rgb(128 128 128/.25);border-radius:12px;padding:16px;height:120px}' +
    '#mock-page .card i{display:block;height:8px;border-radius:4px;background:rgb(128 128 128/.28);margin-bottom:8px}' +
    '#mock-page pre{margin:24px 0 0;padding:16px;border-radius:10px;background:rgb(128 128 128/.12);font:13px/1.6 ui-monospace,Menlo,monospace;overflow:hidden}'
  if (params.get('anim') === '0') mockCss.textContent += '*,*::before,*::after{transition:none!important;animation:none!important}'
  document.head.appendChild(mockCss)

  const backdrop = params.get('backdrop')
  if (backdrop) {
    const page = document.createElement('div')
    page.id = 'mock-page'
    page.className = backdrop === 'dark' ? 'dark' : 'light'
    page.innerHTML =
      '<nav><div class="logo"></div><b>Acme Cloud</b><span>Products</span><span>Solutions</span><span>Docs</span><span>Pricing</span><span class="cta">Get started</span></nav>' +
      '<main><h1>Automate the busywork,<br>keep the craft.</h1>' +
      '<p>Connect the tools your team already uses and let workflows handle the handoffs. Start from a template or build your own in minutes.</p>' +
      '<p>Trusted by teams who present, ship, and iterate in public every week.</p>' +
      '<div class="cards"><div class="card"><i style="width:60%"></i><i></i><i style="width:80%"></i></div><div class="card"><i style="width:50%"></i><i></i><i style="width:70%"></i></div><div class="card"><i style="width:70%"></i><i></i><i style="width:40%"></i></div></div>' +
      '<pre>$ npx stage-browser https://example.com\n✔ opened 3 tabs\n✔ session restored</pre></main>'
    document.body.prepend(page)
  }

  const actions = document.querySelector('browser-action-list')
  if (actions) {
    actions.innerHTML =
      '<span class="mock-action"><i><svg viewBox="0 0 10 10"><path d="M6 0.5L2 5.6h2.4L3.8 9.5 8 4.2H5.5z" fill="#fff"/></svg></i></span>' +
      '<span class="mock-action"><i style="background:linear-gradient(135deg,#10b981,#059669)"><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="3" fill="none" stroke="#fff" stroke-width="1.6"/></svg></i></span>'
  }

  interface Check {
    name: string
    ok: boolean
    info: string
  }

  const describe = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v))

  const runSelfcheck = async (suite: string): Promise<void> => {
    const results: Check[] = []
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    const check = (name: string, ok: unknown, info?: unknown) => void results.push({ name, ok: !!ok, info: ok ? '' : describe(info) })
    const q = (sel: string): HTMLElement => {
      const n = document.querySelector<HTMLElement>(sel)
      if (!n) throw new Error(`${sel} not found`)
      return n
    }
    const qa = (sel: string): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(sel))
    const live = () => qa('#tabs .tab:not(.closing)')
    const rows = () => qa('#omni-list .row')
    const nth = <T,>(items: readonly T[], i: number): T => {
      const item = i < 0 ? items[items.length + i] : items[i]
      if (item === undefined) throw new Error(`no item ${i} of ${items.length}`)
      return item
    }
    const idOf = (n: HTMLElement): TabId => Number(n.dataset.id)
    const input = () => q('#omni-input') as HTMLInputElement
    const omniOpen = () => !q('#omni').hidden
    const lastCall = <K extends CallName>(name: K): CallOf<K> | undefined => calls.findLast((c): c is CallOf<K> => c[0] === name)
    const countCalls = (name: CallName) => calls.filter((c) => c[0] === name).length
    const ptr = (type: string, target: EventTarget, x: number, y: number) =>
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 7, pointerType: 'mouse' }))
    const center = (n: Element): [x: number, y: number] => {
      const r = n.getBoundingClientRect()
      return [r.left + r.width / 2, r.top + r.height / 2]
    }
    const clickTab = (n: HTMLElement) => {
      const [x, y] = center(n)
      ptr('pointerdown', n, x, y)
      ptr('pointerup', window, x, y)
    }
    const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}) =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))
    const type = (v: string) => {
      const i = input()
      i.value = v
      i.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const submitted = () => lastCall('submitOmnibox')

    const finish = () => {
      const pass = results.filter((r) => r.ok).length
      const fail = results.length - pass
      const out = `SELFCHECK ${fail ? 'FAIL' : 'PASS'} ${pass}/${results.length}\n${results.map((r) => `${r.ok ? '  ok   ' : '  FAIL '}${r.name}${r.info ? `  -> ${r.info}` : ''}`).join('\n')}`
      console.log(out)
      const pre = document.createElement('pre')
      pre.id = 'selfcheck'
      pre.textContent = out
      pre.style.cssText = 'position:fixed;left:0;bottom:0;margin:0;font:11px monospace;background:#fff;color:#000;z-index:99;display:none'
      document.body.appendChild(pre)
      document.title = `selfcheck ${fail ? 'FAIL' : 'PASS'}`
    }

    try {
      await sleep(500)
      if (suite === 'many') {
        const tabs = q('#tabs')
        const cap = q('#capsule').getBoundingClientRect()
        check('many: compact class set', tabs.classList.contains('compact'))
        check('many: tabs scroll horizontally when narrow', innerWidth > 900 || tabs.scrollWidth > tabs.clientWidth, `${tabs.scrollWidth} vs ${tabs.clientWidth}`)
        check('many: capsule fits inside strip', cap.right <= innerWidth - 12 + 0.5 && cap.left >= 84 - 0.5, JSON.stringify(cap))
        const inactiveWidth = nth(qa('#tabs .tab:not(.active)'), 0).getBoundingClientRect().width
        check('many: inactive tabs are favicon-only (36px)', Math.abs(inactiveWidth - 36) < 1, inactiveWidth)
        const ar = q('#tabs .tab.active').getBoundingClientRect()
        const tr = tabs.getBoundingClientRect()
        check('many: active tab scrolled into view', ar.left >= tr.left - 1 && ar.right <= tr.right + 1, `${ar.left}..${ar.right} in ${tr.left}..${tr.right}`)
        return finish()
      }

      const n0 = st.tabs.length
      const cap = q('#capsule')
      check('renders one element per tab', live().length === n0, `${live().length} vs ${n0}`)
      check('tablist/tab roles', q('#tabs').getAttribute('role') === 'tablist' && live().every((t) => t.getAttribute('role') === 'tab'))
      check('exactly one aria-selected tab', live().filter((t) => t.getAttribute('aria-selected') === 'true').length === 1)
      check('bar is visible', root.classList.contains('bar-visible'))
      check('capsule leaves 84px for traffic lights', cap.getBoundingClientRect().left >= 84 - 0.5, cap.getBoundingClientRect().left)
      check('capsule is 36px tall at top 8px', Math.abs(cap.getBoundingClientRect().height - 36) < 0.5 && cap.offsetTop === 8, JSON.stringify(cap.getBoundingClientRect()))

      cap.dispatchEvent(new MouseEvent('mouseenter'))
      cap.dispatchEvent(new MouseEvent('mouseleave'))
      const hovers = calls.flatMap((c) => (c[0] === 'setBarHover' ? [c[1]] : []))
      check('capsule hover reports setBarHover(true/false)', hovers.join() === 'true,false')

      const lights = q('#lights').getBoundingClientRect()
      check('traffic lights sit in the leftmost 84px, centred on the capsule', lights.left >= 0 && lights.right <= 84 && Math.abs(lights.top + lights.height / 2 - 26) < 0.5, JSON.stringify(lights))
      q('#light-close').click()
      q('#light-minimize').click()
      q('#light-zoom').click()
      q('#light-zoom').dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))
      const actions = calls.flatMap((c) => (c[0] === 'windowAction' ? [c[1]] : []))
      check('traffic lights → windowAction close, minimize, fullscreen; Option-green → zoom', actions.join() === 'close,minimize,fullscreen,zoom', actions.join())

      const strip = q('#strip')
      const drags = () => countCalls('startWindowDrag') + '/' + countCalls('endWindowDrag')
      ptr('pointerdown', strip, 60, 40)
      ptr('pointerup', window, 60, 40)
      check('strip background pointerdown → startWindowDrag, pointerup → endWindowDrag', drags() === '1/1', drags())
      ptr('pointerdown', q('#new-tab'), 60, 40)
      ptr('pointerdown', nth(live(), 0), 60, 40)
      check('pointerdown on a button or a tab does not drag the window', drags() === '1/1', drags())
      ptr('pointercancel', window, 60, 40)
      strip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      nth(live(), 0).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      check('double-click on the strip background → windowAction("double-click"), on a tab → nothing', calls.filter((c) => c[0] === 'windowAction' && c[1] === 'double-click').length === 1)

      const t0 = nth(live(), 0)
      t0.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
      check('right-click calls showTabMenu', lastCall('showTabMenu')?.[1] === idOf(t0))

      const ids = st.tabs.map((t) => t.id)
      const els = live()
      const [ax, ay] = center(nth(els, 0))
      const [cx] = center(nth(els, 2))
      ptr('pointerdown', nth(els, 0), ax, ay)
      ptr('pointermove', window, ax + 8, ay)
      await sleep(30)
      ptr('pointermove', window, cx + 4, ay)
      await sleep(200)
      const shifted = [nth(els, 1), nth(els, 2)].map((n) => n.style.transform)
      check('drag shifts the tabs it passes', shifted.every((t) => t.includes('translateX')), shifted.join('|'))
      ptr('pointerup', window, cx + 4, ay)
      await sleep(400)
      const mv = lastCall('moveTab')
      check('drop calls moveTab(id, 2)', mv?.[1] === ids[0] && mv?.[2] === 2, JSON.stringify(mv))
      check('DOM order matches state after drop', live().map(idOf).join() === st.tabs.map((t) => t.id).join())
      check('no leftover drag transforms', live().every((t) => !t.style.transform))
      check('drag does not trigger omnibox/activation click', countCalls('openOmnibox') === 0)

      const inactive = nth(
        live().filter((t) => !t.classList.contains('active')),
        1,
      )
      clickTab(inactive)
      await sleep(50)
      check('click inactive tab → activateTab', lastCall('activateTab')?.[1] === idOf(inactive))
      check('tab becomes active (aria-selected)', inactive.getAttribute('aria-selected') === 'true' && inactive.classList.contains('active'))
      clickTab(inactive)
      await sleep(80)
      check('click active tab → openOmnibox("edit")', lastCall('openOmnibox')?.[1] === 'edit')
      check('omnibox visible, input focused', omniOpen() && document.activeElement === input())
      const inp = input()
      check(
        'initial value fully selected',
        inp.value === activeTab()?.url && inp.selectionStart === 0 && inp.selectionEnd === inp.value.length,
        `${inp.value} ${inp.selectionStart}-${inp.selectionEnd}`,
      )
      key(inp, 'Escape')
      await sleep(30)
      check('Esc → closeOverlay and hides', lastCall('closeOverlay') && !omniOpen())

      q('#new-tab').click()
      await sleep(80)
      check('+ → openOmnibox("new") with empty field', lastCall('openOmnibox')?.[1] === 'new' && omniOpen() && input().value === '')
      type('northwind')
      await sleep(250)
      const r = rows()
      check('suggestions render (≤ 8)', r.length > 1 && r.length <= 8, r.length)
      check('first row highlighted by default', r[0]?.classList.contains('sel'))
      key(input(), 'ArrowDown')
      check('ArrowDown moves highlight', nth(rows(), 1).classList.contains('sel') && !nth(rows(), 0).classList.contains('sel'))
      key(input(), 'ArrowUp')
      check('ArrowUp moves back', nth(rows(), 0).classList.contains('sel'))
      key(input(), 'ArrowUp')
      check('ArrowUp wraps to last', nth(rows(), -1).classList.contains('sel'))
      nth(rows(), 1).dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
      check('hover moves highlight', nth(rows(), 1).classList.contains('sel'))

      const tabRow = rows().findIndex((x) => x.classList.contains('is-tab'))
      check('a tab suggestion exists', tabRow >= 0)
      if (tabRow >= 0) {
        nth(rows(), tabRow).dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
        check('tab row shows "Switch to tab" hint', /Switch to tab/.test(nth(rows(), tabRow).textContent ?? ''))
        const before = countCalls('closeOverlay')
        key(input(), 'Enter')
        await sleep(30)
        check('Enter on tab suggestion → activateTab + closeOverlay', lastCall('activateTab') && countCalls('closeOverlay') === before + 1 && !omniOpen())
      }

      q('#new-tab').click()
      await sleep(60)
      type('example.com')
      await sleep(200)
      check('url-like input shows globe glyph', !!document.querySelector('#omni-glyph svg circle') && !document.querySelector('#omni-glyph svg path[d^="M13.2"]'))
      key(input(), 'Enter')
      await sleep(30)
      let sub = submitted()
      check('mode new: Enter → submitOmnibox(url, newTab:true)', sub && /example\.com/.test(sub[1]) && sub[2].newTab, JSON.stringify(sub))

      api.openOmnibox('edit')
      await sleep(60)
      type('other.org')
      await sleep(200)
      key(input(), 'Enter')
      await sleep(30)
      sub = submitted()
      check('mode edit: Enter → newTab:false', sub && /other\.org/.test(sub[1]) && !sub[2].newTab, JSON.stringify(sub))
      api.openOmnibox('edit')
      await sleep(60)
      type('third.net')
      await sleep(200)
      key(input(), 'Enter', { metaKey: true })
      await sleep(30)
      sub = submitted()
      check('mode edit: Cmd+Enter → newTab:true', sub && /third\.net/.test(sub[1]) && sub[2].newTab, JSON.stringify(sub))

      q('#new-tab').click()
      await sleep(60)
      type('sl')
      await sleep(90)
      type('slx')
      await sleep(350)
      const first = rows()[0]
      check('stale suggest() response is dropped', first && /slx/.test(first.textContent ?? '') && !/“sl”/.test(first.textContent ?? ''), first?.textContent)

      type('quickly typed words')
      key(input(), 'Enter')
      await sleep(30)
      sub = submitted()
      check('Enter before debounce submits raw input', sub?.[1] === 'quickly typed words', JSON.stringify(sub))

      q('#new-tab').click()
      await sleep(60)
      q('#omni-backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await sleep(30)
      check('backdrop click → closeOverlay', !omniOpen())

      const victim = nth(live(), 0)
      const vid = idOf(victim)
      const before = live().length
      victim.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
      await sleep(400)
      check('middle-click → closeTab', lastCall('closeTab')?.[1] === vid)
      check('closed tab leaves the DOM', live().length === before - 1 && !qa('#tabs .tab').some((t) => idOf(t) === vid), `${live().length} ${qa('#tabs .tab').length}`)
      const v2 = nth(live(), 1)
      const v2id = idOf(v2)
      v2.querySelector<HTMLElement>('.close')?.click()
      await sleep(400)
      check('close button → closeTab', lastCall('closeTab')?.[1] === v2id)

      finish()
    } catch (e) {
      check('selfcheck threw', false, e instanceof Error ? e.stack : e)
      finish()
    }
  }

  const suite = params.get('selfcheck')
  if (suite) window.addEventListener('load', () => setTimeout(() => void runSelfcheck(suite), 400))
}

// The tab capsule and omnibox. A classic script (the page's CSP only allows 'self'), so it has no
// imports. It talks to the main process only through window.stage; in a plain browser, mock.js fakes it.
{
  type StageApi = import('../shared/contract').StageApi
  type StageState = import('../shared/contract').StageState
  type TabSnapshot = import('../shared/contract').TabSnapshot
  type TabId = import('../shared/contract').TabId
  type OmniboxMode = import('../shared/contract').OmniboxMode
  type OmniboxOverlay = import('../shared/contract').OmniboxOverlay
  type Suggestion = import('../shared/contract').Suggestion
  type WindowAction = import('../shared/contract').WindowAction

  const STRIP_LEFT = 84
  const STRIP_RIGHT = 12
  const CAPSULE_PAD = 8
  const TAB_MIN = 72
  const TAB_GAP = 2
  const DRAG_THRESHOLD = 4
  const SUGGEST_DEBOUNCE = 60
  const MAX_SUGGESTIONS = 8
  const CLOSE_ANIMATION_MS = 260
  const SETTLE_MS = 150

  const ICONS = {
    close: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3l6 6M9 3L3 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    newtab: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.2 2"/></svg>',
    speaker:
      '<svg class="on" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M2.5 5.5h2l3-2.5v8l-3-2.5h-2z" fill="currentColor"/><path d="M9.5 5a3 3 0 0 1 0 4M11 3.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
      '<svg class="off" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M2.5 5.5h2l3-2.5v8l-3-2.5h-2z" fill="currentColor"/><path d="M9.5 5.5l3 3M12.5 5.5l-3 3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    search: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13.2 13.2L17 17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    globe: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 10h14M10 3c2.2 2.1 3.3 4.4 3.3 7s-1.1 4.9-3.3 7c-2.2-2.1-3.3-4.4-3.3-7S7.8 5.1 10 3z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    clock: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 6v4.2l2.8 1.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    tab: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="5" width="14" height="10.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 8.5h14" stroke="currentColor" stroke-width="1.5"/></svg>',
  } as const

  const SUGGESTION_ICON: Record<Suggestion['kind'], keyof typeof ICONS> = { search: 'search', url: 'globe', history: 'clock', tab: 'tab' }

  type IconKind = 'spin' | 'img' | 'mono' | 'blank'
  type Painted = Pick<TabSnapshot, 'title' | 'url' | 'favicon' | 'loading' | 'audible' | 'muted'> & { active: boolean }

  interface TabView {
    node: HTMLDivElement
    ico: HTMLSpanElement
    img: HTMLImageElement
    mono: HTMLSpanElement
    title: HTMLSpanElement
    aud: HTMLSpanElement
    painted: Partial<Painted>
    failedFavicon: string | null
  }

  interface Slot {
    node: HTMLElement
    left: number
    width: number
    center: number
  }

  interface PendingDrag {
    started: false
    id: TabId
    node: HTMLElement
    startX: number
    startScroll: number
    wasActive: boolean
    pointerId: number
  }

  interface ActiveDrag extends Omit<PendingDrag, 'started'> {
    started: true
    slots: Slot[]
    index: number
    target: number
    minDx: number
    maxDx: number
  }

  type Drag = PendingDrag | ActiveDrag

  interface OmniboxView {
    open: boolean
    mode: OmniboxMode
    initial: string
    nonce: number | null
    items: Suggestion[]
    sel: number
    seq: number
    timer: ReturnType<typeof setTimeout> | undefined
    answered: string | null
  }

  const byId = <T extends HTMLElement>(id: string, type: { new (): T; prototype: T }): T => {
    const node = document.getElementById(id)
    if (!(node instanceof type)) throw new Error(`#${id} is missing`)
    return node
  }

  const create = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag)
    if (className) node.className = className
    return node
  }

  const child = <T extends Element>(parent: ParentNode, selector: string, type: { new (): T; prototype: T }): T => {
    const node = parent.querySelector(selector)
    if (!(node instanceof type)) throw new Error(`${selector} is missing`)
    return node
  }

  const closest = (target: EventTarget | null, selector: string): HTMLElement | null =>
    target instanceof Element ? target.closest<HTMLElement>(selector) : null

  const hostOf = (url: string): string => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  }

  const hashHue = (text: string): number => {
    let h = 0
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0
    return h % 360
  }

  const prettyUrl = (url: string): string => url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '')

  const looksLikeUrl = (raw: string): boolean => {
    const v = raw.trim()
    if (!v || /\s/.test(v)) return false
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^localhost(:\d+)?(\/|$)/i.test(v) || /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/|$|\?)/i.test(v)
  }

  const translateX = (px: number): string => (px ? `translateX(${px}px)` : '')

  const tabIdOf = (node: HTMLElement): TabId => Number(node.dataset.id)

  const tabFromEvent = (e: Event): HTMLElement | null => {
    const node = closest(e.target, '.tab')
    return node && !node.classList.contains('closing') ? node : null
  }

  const draggedSlot = (d: ActiveDrag): Slot => {
    const me = d.slots[d.index]
    if (!me) throw new Error('drag lost its tab')
    return me
  }

  const settleOffset = (d: ActiveDrag): number => {
    let dx = 0
    if (d.target > d.index) for (let i = d.index + 1; i <= d.target; i++) dx += (d.slots[i]?.width ?? 0) + TAB_GAP
    else for (let i = d.target; i < d.index; i++) dx -= (d.slots[i]?.width ?? 0) + TAB_GAP
    return dx
  }

  const resetSlots = (d: ActiveDrag): void => {
    for (const s of d.slots) {
      s.node.style.transform = ''
      s.node.style.transition = ''
    }
    d.node.classList.remove('dragging')
  }

  const iconFor = (item: Suggestion): string =>
    item.favicon ? `<img alt="" draggable="false" src="${item.favicon.replace(/"/g, '&quot;')}">` : ICONS[SUGGESTION_ICON[item.kind]]

  const boot = (stage: StageApi): void => {
    const root = document.documentElement
    const strip = byId('strip', HTMLElement)
    const capsule = byId('capsule', HTMLElement)
    const lights = byId('lights', HTMLElement)
    const minimizeBtn = byId('light-minimize', HTMLButtonElement)
    const zoomBtn = byId('light-zoom', HTMLButtonElement)
    const tabsEl = byId('tabs', HTMLElement)
    const controlsEl = byId('controls', HTMLElement)
    const newBtn = byId('new-tab', HTMLButtonElement)
    const omni = byId('omni', HTMLElement)
    const backdrop = byId('omni-backdrop', HTMLElement)
    const panel = byId('omni-panel', HTMLElement)
    const input = byId('omni-input', HTMLInputElement)
    const list = byId('omni-list', HTMLElement)
    const glyph = byId('omni-glyph', HTMLElement)

    const views = new Map<TabId, TabView>()
    let state: StageState | null = null
    let drag: Drag | null = null
    let firstRender = true
    let layoutQueued = false

    const ob: OmniboxView = { open: false, mode: 'new', initial: '', nonce: null, items: [], sel: 0, seq: 0, timer: undefined, answered: null }

    const apply = (next: StageState): void => {
      const initial = state === null
      state = next
      renderBar(next, initial)
      renderOverlay(next)
    }


    const liveTabNodes = (): HTMLElement[] =>
      Array.from(tabsEl.children).filter((c): c is HTMLElement => c instanceof HTMLElement && !c.classList.contains('closing'))

    const renderBar = (s: StageState, initial: boolean): void => {
      if (initial) {
        if (s.bar.visible) {
          void capsule.offsetWidth
          root.classList.add('bar-visible')
        }
      } else {
        root.classList.toggle('bar-visible', s.bar.visible)
      }
      root.classList.toggle('bar-pinned', s.bar.pinned)
      root.classList.toggle('hide-ext', s.hideExtensionIcons)
      root.classList.toggle('no-ext', !s.extensionActions)
      // A full-screen window can't be minimized, and green takes it back out.
      minimizeBtn.disabled = s.fullscreen
      zoomBtn.setAttribute('aria-label', s.fullscreen ? 'Exit full screen' : 'Enter full screen')
      renderTabs(s)
    }

    const renderTabs = (s: StageState): void => {
      const structural = !drag
      if (structural) {
        const ids = new Set(s.tabs.map((t) => t.id))
        for (const [id, view] of views) if (!ids.has(id)) removeTab(id, view)
      }
      let prev: HTMLElement | null = null
      for (const t of s.tabs) {
        let view = views.get(t.id)
        if (!view) {
          if (!structural) continue
          view = createTab(t, !firstRender)
          views.set(t.id, view)
        }
        updateTab(view, t, t.id === s.activeTabId)
        if (structural) {
          let ref: Element | null = prev ? prev.nextElementSibling : tabsEl.firstElementChild
          while (ref?.classList.contains('closing')) ref = ref.nextElementSibling
          if (ref !== view.node) tabsEl.insertBefore(view.node, ref)
          prev = view.node
        }
      }
      firstRender = false
      layoutTabs()
    }

    const createTab = (t: TabSnapshot, animate: boolean): TabView => {
      const node = create('div', 'tab')
      node.setAttribute('role', 'tab')
      node.dataset.id = String(t.id)
      node.tabIndex = -1
      node.innerHTML =
        `<span class="ico" data-k="blank"><img class="fav" alt="" draggable="false"><span class="mono" aria-hidden="true"></span><span class="spin" aria-hidden="true"></span><span class="blank">${ICONS.newtab}</span></span>` +
        '<span class="title"></span>' +
        `<span class="aud" aria-hidden="true">${ICONS.speaker}</span>` +
        `<button class="close" type="button" tabindex="-1" aria-label="Close tab">${ICONS.close}</button>`
      const view: TabView = {
        node,
        ico: child(node, '.ico', HTMLSpanElement),
        img: child(node, '.fav', HTMLImageElement),
        mono: child(node, '.mono', HTMLSpanElement),
        title: child(node, '.title', HTMLSpanElement),
        aud: child(node, '.aud', HTMLSpanElement),
        painted: {},
        failedFavicon: null,
      }
      view.img.addEventListener('error', () => {
        view.failedFavicon = view.painted.favicon ?? null
        const snapshot = state?.tabs.find((x) => x.id === t.id)
        if (snapshot) paintIcon(view, snapshot)
      })
      if (animate) {
        node.classList.add('entering')
        node.addEventListener('animationend', () => node.classList.remove('entering'), { once: true })
      }
      return view
    }

    const paintIcon = (view: TabView, t: TabSnapshot): void => {
      let kind: IconKind
      if (t.loading) kind = 'spin'
      else if (t.favicon && view.failedFavicon !== t.favicon) {
        kind = 'img'
        if (view.img.getAttribute('src') !== t.favicon) view.img.setAttribute('src', t.favicon)
      } else if (t.url) {
        kind = 'mono'
        const host = hostOf(t.url) || t.url
        view.mono.textContent = /[a-z0-9]/i.exec(host)?.[0] ?? '•'
        view.mono.style.setProperty('--h', String(hashHue(host)))
      } else kind = 'blank'
      if (view.ico.dataset.k !== kind) view.ico.dataset.k = kind
    }

    const updateTab = (view: TabView, t: TabSnapshot, active: boolean): void => {
      const { node, painted: p } = view
      if (p.title !== t.title || p.url !== t.url) {
        const label = t.title || prettyUrl(t.url) || 'New Tab'
        view.title.textContent = label
        node.setAttribute('aria-label', label)
      }
      if (p.favicon !== t.favicon || p.loading !== t.loading || p.url !== t.url) paintIcon(view, t)
      if (p.audible !== t.audible || p.muted !== t.muted) {
        node.classList.toggle('has-aud', t.audible || t.muted)
        view.aud.classList.toggle('is-muted', t.muted)
      }
      if (p.active !== active) {
        node.classList.toggle('active', active)
        node.setAttribute('aria-selected', String(active))
        node.tabIndex = active ? 0 : -1
        if (active) keepInView(node)
      }
      view.painted = { title: t.title, url: t.url, favicon: t.favicon, loading: t.loading, audible: t.audible, muted: t.muted, active }
    }

    const removeTab = (id: TabId, { node }: TabView): void => {
      views.delete(id)
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return node.remove()
      node.classList.remove('entering')
      node.classList.add('closing')
      node.setAttribute('aria-hidden', 'true')
      let done = false
      const finish = () => {
        if (done) return
        done = true
        node.remove()
        layoutTabs()
      }
      node.addEventListener('animationend', finish, { once: true })
      setTimeout(finish, CLOSE_ANIMATION_MS)
    }

    const keepInView = (node: HTMLElement): void => {
      requestAnimationFrame(() => {
        const l = node.offsetLeft
        const r = l + node.offsetWidth
        const vl = tabsEl.scrollLeft
        const vr = vl + tabsEl.clientWidth
        if (l < vl + 8) tabsEl.scrollTo({ left: Math.max(0, l - 8), behavior: 'smooth' })
        else if (r > vr - 8) tabsEl.scrollTo({ left: r - tabsEl.clientWidth + 8, behavior: 'smooth' })
      })
    }

    const layoutTabs = (): void => {
      if (layoutQueued) return
      layoutQueued = true
      requestAnimationFrame(() => {
        layoutQueued = false
        const n = views.size
        const fixed = CAPSULE_PAD + newBtn.offsetWidth + controlsEl.offsetWidth + TAB_GAP * 2
        const avail = root.clientWidth - STRIP_LEFT - STRIP_RIGHT - fixed
        tabsEl.classList.toggle('compact', n > 1 && n * TAB_MIN + (n - 1) * TAB_GAP > avail)
        updateFades()
      })
    }

    const updateFades = (): void => {
      const max = tabsEl.scrollWidth - tabsEl.clientWidth
      tabsEl.classList.toggle('fade-l', tabsEl.scrollLeft > 1)
      tabsEl.classList.toggle('fade-r', max > 1 && tabsEl.scrollLeft < max - 1)
    }


    const beginDrag = (d: PendingDrag): ActiveDrag => {
      const nodes = liveTabNodes()
      const slots = nodes.map((node): Slot => {
        const r = node.getBoundingClientRect()
        return { node, left: r.left, width: r.width, center: r.left + r.width / 2 }
      })
      const index = nodes.indexOf(d.node)
      const me = slots[index]
      const first = slots[0]
      const last = slots.at(-1)
      if (!me || !first || !last) throw new Error('dragged tab is not in the strip')
      d.node.classList.add('dragging')
      try {
        d.node.setPointerCapture(d.pointerId)
      } catch {}
      document.body.style.cursor = 'grabbing'
      return { ...d, started: true, slots, index, target: index, minDx: first.left - me.left, maxDx: last.left + last.width - me.width - me.left }
    }




    const onDragMove = (e: PointerEvent): void => {
      if (!drag) return
      const raw = e.clientX - drag.startX + (tabsEl.scrollLeft - drag.startScroll)
      if (!drag.started) {
        if (Math.abs(raw) < DRAG_THRESHOLD) return
        drag = beginDrag(drag)
      }
      const d = drag
      const me = draggedSlot(d)
      const dx = Math.max(d.minDx, Math.min(d.maxDx, raw))
      d.node.style.transform = translateX(dx)
      const center = me.center + dx
      const target = d.slots.filter((s, i) => i !== d.index && s.center < center).length
      if (target === d.target) return
      d.target = target
      const w = me.width + TAB_GAP
      d.slots.forEach((s, i) => {
        if (i === d.index) return
        let shift = 0
        if (target > d.index && i > d.index && i <= target) shift = -w
        else if (target < d.index && i >= target && i < d.index) shift = w
        s.node.style.transform = translateX(shift)
      })
    }

    const stopListening = (): void => {
      window.removeEventListener('pointermove', onDragMove)
      window.removeEventListener('pointerup', onDragEnd)
      window.removeEventListener('pointercancel', onDragCancel)
      document.body.style.cursor = ''
    }

    const onDragEnd = (): void => {
      const d = drag
      if (!d) return
      stopListening()
      if (!d.started) {
        drag = null
        if (d.wasActive) stage.openOmnibox('edit')
        return
      }
      d.node.style.transition = 'transform 140ms var(--ease-out), background-color 140ms ease, box-shadow 140ms ease'
      d.node.style.transform = translateX(settleOffset(d))
      setTimeout(() => commitDrag(d), SETTLE_MS)
    }

    const commitDrag = (d: ActiveDrag): void => {
      tabsEl.classList.add('no-anim')
      const others = d.slots.filter((_, i) => i !== d.index)
      tabsEl.insertBefore(d.node, others[d.target]?.node ?? null)
      resetSlots(d)
      void tabsEl.offsetWidth
      tabsEl.classList.remove('no-anim')
      drag = null
      if (d.target !== d.index) stage.moveTab(d.id, d.target)
      if (state) renderTabs(state)
    }

    const onDragCancel = (): void => {
      const d = drag
      if (!d) return
      stopListening()
      if (d.started) resetSlots(d)
      drag = null
      if (state) renderTabs(state)
    }

    const renderOverlay = (s: StageState): void => {
      const o = s.overlay?.type === 'omnibox' ? s.overlay : null
      if (!o) {
        if (ob.open) closeOmnibox()
        return
      }
      if (!ob.open || ob.mode !== o.mode || ob.initial !== o.initial || ob.nonce !== o.nonce) openOmnibox(o)
    }

    const openOmnibox = (o: OmniboxOverlay): void => {
      const wasOpen = ob.open
      Object.assign(ob, { open: true, mode: o.mode, initial: o.initial, nonce: o.nonce, items: [], sel: 0, answered: null })
      omni.hidden = false
      if (!wasOpen) {
        for (const n of [panel, backdrop]) {
          n.style.animation = 'none'
          void n.offsetWidth
          n.style.animation = ''
        }
      }
      input.value = ob.initial
      updateGlyph()
      renderList()
      input.focus()
      input.select()
      requestSuggest(ob.initial, true)
    }

    const closeOmnibox = (): void => {
      ob.open = false
      ob.seq++
      clearTimeout(ob.timer)
      ob.items = []
      omni.hidden = true
      omni.classList.remove('cmd')
      list.textContent = ''
      input.blur()
    }

    const updateGlyph = (): void => {
      glyph.innerHTML = looksLikeUrl(input.value) ? ICONS.globe : ICONS.search
    }

    const requestSuggest = (query: string, immediate: boolean): void => {
      clearTimeout(ob.timer)
      const mine = ++ob.seq
      const run = async () => {
        const res = await stage.suggest(query).catch(() => null)
        if (!res || mine !== ob.seq || !ob.open) return
        ob.items = res.slice(0, MAX_SUGGESTIONS)
        ob.answered = query
        ob.sel = 0
        renderList()
      }
      if (immediate) void run()
      else ob.timer = setTimeout(() => void run(), SUGGEST_DEBOUNCE)
    }


    const renderList = (): void => {
      list.textContent = ''
      input.setAttribute('aria-expanded', String(ob.items.length > 0))
      ob.items.forEach((item, i) => {
        const row = create('div', item.kind === 'tab' ? 'row is-tab' : 'row')
        row.id = `omni-row-${i}`
        row.setAttribute('role', 'option')
        let url = item.kind === 'search' ? '' : prettyUrl(item.url)
        const title = item.title || url
        if (url === title) url = ''
        const hint =
          item.kind === 'tab'
            ? '<span>Switch to tab</span><kbd>↵</kbd>'
            : '<span class="h-ret"><kbd>↵</kbd></span><span class="h-cmd"><span>New tab</span><kbd>⌘↵</kbd></span>'
        row.innerHTML = `<span class="r-ico">${iconFor(item)}</span><span class="r-title"></span><span class="r-url"></span><span class="hint">${hint}</span>`
        child(row, '.r-title', HTMLSpanElement).textContent = title
        child(row, '.r-url', HTMLSpanElement).textContent = url
        const img = row.querySelector('.r-ico img')
        img?.addEventListener('error', () => {
          if (img.parentElement) img.parentElement.innerHTML = ICONS[item.kind === 'tab' ? 'tab' : 'globe']
        })
        row.addEventListener('mousedown', (e) => e.preventDefault())
        row.addEventListener('mousemove', () => {
          if (ob.sel !== i) select(i, false)
        })
        row.addEventListener('click', (e) => commit(item, e.metaKey))
        list.appendChild(row)
      })
      paintSelection(false)
    }

    const paintSelection = (scroll: boolean): void => {
      const rows = Array.from(list.children)
      rows.forEach((row, i) => {
        const on = i === ob.sel
        row.classList.toggle('sel', on)
        row.setAttribute('aria-selected', String(on))
        if (!on) return
        input.setAttribute('aria-activedescendant', row.id)
        if (scroll) row.scrollIntoView({ block: 'nearest' })
      })
      if (!rows.length) input.removeAttribute('aria-activedescendant')
    }

    const select = (i: number, scroll = true): void => {
      const n = ob.items.length
      if (!n) return
      ob.sel = (i + n) % n
      paintSelection(scroll)
    }

    const commit = (item: Suggestion | undefined, cmd: boolean): void => {
      if (item?.kind === 'tab') {
        stage.activateTab(item.tabId)
        stage.closeOverlay()
        return
      }
      const text = item ? item.url : input.value
      if (!text) return stage.closeOverlay()
      stage.submitOmnibox(text, { newTab: ob.mode === 'new' || cmd })
    }

    stage.getState().then(apply, () => {})
    stage.onState(apply)

    // When the bar floats over the page, the view reaches below the strip so the capsule's shadow
    // isn't clipped. Clicks in that transparent band belong to the page underneath.
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target !== document.body && e.target !== root) return
        if (!state || state.overlay || e.clientY < state.barHeight) return
        e.preventDefault()
        stage.passClick(e.clientX, e.clientY, e.button, e.detail || 1)
      },
      true,
    )

    tabsEl.addEventListener('scroll', updateFades, { passive: true })
    tabsEl.addEventListener(
      'wheel',
      (e) => {
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
        tabsEl.scrollLeft += e.deltaY
        e.preventDefault()
      },
      { passive: false },
    )
    window.addEventListener('resize', layoutTabs)
    new ResizeObserver(layoutTabs).observe(controlsEl)

    tabsEl.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault()
    })
    tabsEl.addEventListener('auxclick', (e) => {
      const node = e.button === 1 ? tabFromEvent(e) : null
      if (!node) return
      e.preventDefault()
      stage.closeTab(tabIdOf(node))
    })
    tabsEl.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const node = tabFromEvent(e)
      if (node) stage.showTabMenu(tabIdOf(node))
    })
    tabsEl.addEventListener('click', (e) => {
      const node = closest(e.target, '.close') ? tabFromEvent(e) : null
      if (!node) return
      e.stopPropagation()
      stage.closeTab(tabIdOf(node))
    })
    tabsEl.addEventListener('keydown', (e) => {
      const node = tabFromEvent(e)
      if (!node) return
      const id = tabIdOf(node)
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        if (node.classList.contains('active')) stage.openOmnibox('edit')
        else stage.activateTab(id)
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const nodes = liveTabNodes()
        const next = nodes[nodes.indexOf(node) + (e.key === 'ArrowRight' ? 1 : -1)]
        if (!next) return
        e.preventDefault()
        next.focus()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        stage.closeTab(id)
      }
    })

    tabsEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || drag || closest(e.target, '.close')) return
      const node = tabFromEvent(e)
      if (!node) return
      const id = tabIdOf(node)
      const wasActive = state?.activeTabId === id
      if (!wasActive) stage.activateTab(id)
      drag = { started: false, id, node, startX: e.clientX, startScroll: tabsEl.scrollLeft, wasActive, pointerId: e.pointerId }
      window.addEventListener('pointermove', onDragMove)
      window.addEventListener('pointerup', onDragEnd)
      window.addEventListener('pointercancel', onDragCancel)
    })

    // The strip is the window's title bar: its background drags the window and a double-click
    // zooms it. Tabs, buttons and extension icons keep their own clicks.
    const onBarBackground = (e: Event): boolean => e.target instanceof Element && !e.target.closest('#tabs, button, browser-action-list')
    // The window moves with the cursor, so the button comes up over the strip in this document.
    const endWindowDrag = (): void => {
      window.removeEventListener('pointerup', endWindowDrag)
      window.removeEventListener('pointercancel', endWindowDrag)
      stage.endWindowDrag()
    }
    strip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !onBarBackground(e)) return
      stage.startWindowDrag()
      window.addEventListener('pointerup', endWindowDrag)
      window.addEventListener('pointercancel', endWindowDrag)
    })
    strip.addEventListener('dblclick', (e) => {
      if (onBarBackground(e)) stage.windowAction('double-click')
    })

    const lightActions: [string, (e: MouseEvent) => WindowAction][] = [
      ['light-close', () => 'close'],
      ['light-minimize', () => 'minimize'],
      // Option-click zooms instead, as on any Mac window.
      ['light-zoom', (e) => (e.altKey ? 'zoom' : 'fullscreen')],
    ]
    for (const [id, action] of lightActions) byId(id, HTMLButtonElement).addEventListener('click', (e) => stage.windowAction(action(e)))
    // The UI window never has keyboard focus here, so the Option key is read off the mouse events.
    const trackAlt = (e: MouseEvent) => lights.classList.toggle('alt', e.altKey)
    lights.addEventListener('mousemove', trackAlt)
    lights.addEventListener('mouseenter', trackAlt)

    newBtn.addEventListener('click', () => stage.openOmnibox('new'))
    capsule.addEventListener('mouseenter', () => stage.setBarHover(true))
    capsule.addEventListener('mouseleave', () => stage.setBarHover(false))

    input.addEventListener('input', () => {
      updateGlyph()
      requestSuggest(input.value, false)
    })
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return
      if (e.key === 'Meta') omni.classList.add('cmd')
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        select(ob.sel + (e.key === 'ArrowDown' ? 1 : -1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        // Suggestions answer older text until they catch up, so submit exactly what is typed.
        const item = ob.answered === input.value ? ob.items[ob.sel] : undefined
        if (!item && !input.value.trim()) return stage.closeOverlay()
        commit(item, e.metaKey)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        stage.closeOverlay()
      }
    })
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Meta' && ob.open) omni.classList.add('cmd')
      if (e.key === 'Escape' && ob.open && e.target !== input) stage.closeOverlay()
    })
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Meta') omni.classList.remove('cmd')
    })
    window.addEventListener('blur', () => omni.classList.remove('cmd'))
    window.addEventListener('focus', () => {
      if (ob.open) input.focus()
    })

    backdrop.addEventListener('mousedown', () => stage.closeOverlay())
    omni.addEventListener('mousedown', (e) => {
      if (e.target !== input && e.target instanceof Node && panel.contains(e.target)) e.preventDefault()
    })
  }

  const start = (): void => {
    if (window.stage) boot(window.stage)
  }

  if (window.stage) start()
  else {
    const mock = document.createElement('script')
    mock.src = 'mock.js'
    mock.addEventListener('load', start, { once: true })
    document.head.appendChild(mock)
  }
}

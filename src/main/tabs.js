'use strict'
const path = require('path')
const { WebContentsView, shell } = require('electron')
const store = require('./store')
const { isWebUrl } = require('./url')

const NEWTAB_FILE = path.join(__dirname, '..', 'ui', 'newtab.html')
const WEB_SCHEMES = new Set(['http:', 'https:', 'file:', 'about:', 'data:', 'blob:', 'chrome-extension:', 'view-source:', 'devtools:', 'chrome:', 'javascript:'])

function schemeOf(url) {
  const m = /^([a-z][a-z0-9+.-]*:)/i.exec(url || '')
  return m ? m[1].toLowerCase() : ''
}

class Tabs {
  constructor(ctx) {
    this.ctx = ctx
    this.list = []
    this.activeId = null
    this.closed = [] // urls, most recent last
  }

  get(id) {
    return this.list.find((t) => t.id === id)
  }
  get active() {
    return this.get(this.activeId)
  }

  // ---- creation ----------------------------------------------------------
  // opts: { url?: string, activate?: boolean, webContents?: WebContents, index?: number }
  // `webContents` comes from Electron's window-open path: the view must adopt it (it keeps
  // window.opener) and Electron drives its first navigation.
  create(opts = {}) {
    const { ctx } = this
    const activate = opts.activate !== false
    const view = opts.webContents
      ? new WebContentsView({ webContents: opts.webContents })
      : new WebContentsView({
          webPreferences: { session: ctx.session, sandbox: true, contextIsolation: true, nodeIntegration: false },
        })
    view.setBackgroundColor(ctx.bgColor())
    const wc = view.webContents
    const tab = {
      id: wc.id,
      view,
      wc,
      title: '',
      url: '',
      favicon: null,
      loading: false,
      audible: false,
      muted: false,
      newTab: false,
    }
    const at = typeof opts.index === 'number' ? opts.index : this.list.length
    this.list.splice(at, 0, tab)
    ctx.win.contentView.addChildView(view, 0) // UI view stays on top
    view.setBounds(ctx.tabBounds())
    view.setVisible(false)
    this.wire(tab)
    ctx.ext && ctx.ext.addTab(wc, ctx.win)
    if (!opts.webContents) {
      if (opts.url) this.load(tab, opts.url)
      else this.loadNewTab(tab)
    }
    if (activate) this.activate(tab.id)
    else ctx.push()
    return tab
  }

  loadNewTab(tab) {
    tab.newTab = true
    tab.wc.loadFile(NEWTAB_FILE).catch(() => {})
  }

  load(tab, url) {
    tab.newTab = false
    tab.wc.loadURL(url).catch(() => {}) // ERR_ABORTED etc. are reported via did-fail-load
  }

  // ---- wiring ------------------------------------------------------------
  wire(tab) {
    const { wc } = tab
    const push = () => this.ctx.push()
    const syncUrl = () => {
      const u = wc.getURL()
      tab.newTab = u.startsWith('file://') && decodeURI(u).endsWith('/ui/newtab.html')
      tab.url = tab.newTab ? '' : u
    }
    wc.on('page-title-updated', (_e, title) => {
      tab.title = title
      if (isWebUrl(tab.url)) store.setHistoryTitle(tab.url, title)
      push()
    })
    wc.on('page-favicon-updated', (_e, favs) => {
      tab.favicon = favs[0] || null
      push()
    })
    wc.on('did-start-navigation', (e) => {
      if (e.isMainFrame && !e.isSameDocument) tab.favicon = null
    })
    wc.on('did-start-loading', () => {
      tab.loading = true
      push()
    })
    wc.on('did-stop-loading', () => {
      tab.loading = false
      syncUrl()
      if (!tab.title && tab.url) tab.title = tab.url
      push()
    })
    wc.on('did-navigate', (_e, url) => {
      syncUrl()
      if (isWebUrl(url)) store.addVisit(url, wc.getTitle())
      this.ctx.saveSession()
      push()
    })
    wc.on('did-navigate-in-page', (_e, _url, isMain) => {
      if (!isMain) return
      syncUrl()
      this.ctx.saveSession()
      push()
    })
    wc.on('audio-state-changed', (e) => {
      tab.audible = !!e.audible
      push()
    })
    wc.on('zoom-changed', push)
    wc.on('did-fail-load', (_e, code, _d, _u, isMain) => {
      if (isMain && code !== -3) {
        syncUrl()
        push()
      }
    })
    wc.on('destroyed', () => this.removeDead(tab))
    wc.on('context-menu', (_e, params) => require('./context-menu').showPageMenu(this.ctx, tab, params))

    const external = (e, url) => {
      const s = schemeOf(url)
      if (s && !WEB_SCHEMES.has(s)) {
        e.preventDefault()
        shell.openExternal(url).catch(() => {})
      }
    }
    wc.on('will-navigate', external)
    wc.on('will-redirect', external)
    wc.setWindowOpenHandler((d) => this.openHandler(d))
  }

  // Shared by tab webContents and sign-in popup windows.
  openHandler(d) {
    const { url, disposition } = d
    const s = schemeOf(url)
    if (s && !WEB_SCHEMES.has(s)) {
      shell.openExternal(url).catch(() => {})
      return { action: 'deny' }
    }
    if (disposition === 'new-window') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: this.ctx.bgColor(), webPreferences: { sandbox: true, contextIsolation: true } },
      }
    }
    const background = disposition === 'background-tab'
    return {
      action: 'allow',
      createWindow: (options) => {
        const tab = this.create({
          webContents: options.webContents,
          url: options.webContents ? undefined : url,
          activate: !background,
          index: this.insertIndexAfterActive(),
        })
        return tab.wc
      },
    }
  }

  insertIndexAfterActive() {
    const i = this.list.findIndex((t) => t.id === this.activeId)
    return i < 0 ? this.list.length : i + 1
  }

  // Popup windows (OAuth etc.) get the same link/scheme handling.
  attachPopup(win) {
    const wc = win.webContents
    wc.setWindowOpenHandler((d) => this.openHandler(d))
    const external = (e, url) => {
      const s = schemeOf(url)
      if (s && !WEB_SCHEMES.has(s)) {
        e.preventDefault()
        shell.openExternal(url).catch(() => {})
      }
    }
    wc.on('will-navigate', external)
    wc.on('will-redirect', external)
  }

  // ---- state transitions -------------------------------------------------
  activate(id) {
    const tab = this.get(id)
    if (!tab) return
    this.activeId = id
    for (const t of this.list) t.view.setVisible(t === tab)
    tab.view.setBounds(this.ctx.tabBounds())
    this.ctx.ext && this.ctx.ext.selectTab(tab.wc)
    if (!this.ctx.overlay) tab.wc.focus()
    this.ctx.saveSession()
    this.ctx.push()
  }

  focusActive() {
    const t = this.active
    if (t && !t.wc.isDestroyed()) t.wc.focus()
  }

  close(id) {
    const tab = this.get(id)
    if (!tab) return
    if (tab.url && isWebUrl(tab.url)) this.closed.push(tab.url)
    if (this.closed.length > 25) this.closed.shift()
    this.removeFromList(tab)
    try {
      this.ctx.win.contentView.removeChildView(tab.view)
    } catch {}
    try {
      this.ctx.ext && this.ctx.ext.removeTab(tab.wc)
    } catch {}
    if (!tab.wc.isDestroyed()) tab.wc.close()
  }

  // webContents went away on its own (window.close(), crash cleanup)
  removeDead(tab) {
    if (!this.get(tab.id)) return
    this.removeFromList(tab)
    try {
      this.ctx.win.contentView.removeChildView(tab.view)
    } catch {}
  }

  removeFromList(tab) {
    const i = this.list.indexOf(tab)
    if (i < 0) return
    this.list.splice(i, 1)
    if (this.ctx.quitting) return
    if (this.list.length === 0) {
      this.create({})
      return
    }
    if (this.activeId === tab.id) this.activate(this.list[Math.min(i, this.list.length - 1)].id)
    else {
      this.ctx.saveSession()
      this.ctx.push()
    }
  }

  closeOthers(id) {
    for (const t of [...this.list]) if (t.id !== id) this.close(t.id)
  }
  closeRight(id) {
    const i = this.list.findIndex((t) => t.id === id)
    for (const t of this.list.slice(i + 1)) this.close(t.id)
  }

  reopenClosed() {
    const url = this.closed.pop()
    if (url) this.create({ url })
  }

  duplicate(id) {
    const t = this.get(id)
    if (!t) return
    const i = this.list.indexOf(t)
    this.create(t.url ? { url: t.url, index: i + 1 } : { index: i + 1 })
  }

  move(id, toIndex) {
    const from = this.list.findIndex((t) => t.id === id)
    if (from < 0) return
    const [t] = this.list.splice(from, 1)
    this.list.splice(Math.max(0, Math.min(toIndex, this.list.length)), 0, t)
    this.ctx.saveSession()
    this.ctx.push()
  }

  step(delta) {
    if (this.list.length < 2) return
    const i = this.list.findIndex((t) => t.id === this.activeId)
    this.activate(this.list[(i + delta + this.list.length) % this.list.length].id)
  }

  goTo(n) {
    // n is 1-based; 9 means last
    const t = n === 9 ? this.list[this.list.length - 1] : this.list[n - 1]
    if (t) this.activate(t.id)
  }

  toggleMute(id) {
    const t = this.get(id)
    if (!t) return
    t.muted = !t.muted
    t.wc.setAudioMuted(t.muted)
    this.ctx.push()
  }

  // navigate the active tab (or open a new one)
  open(url, { newTab }) {
    const t = this.active
    if (newTab || !t) return this.create({ url, index: this.insertIndexAfterActive() })
    this.load(t, url)
    this.activate(t.id)
    return t
  }

  layout() {
    const b = this.ctx.tabBounds()
    for (const t of this.list) t.view.setBounds(b)
  }

  zoom(delta) {
    const t = this.active
    if (!t) return
    const f = delta === 0 ? 1 : Math.min(5, Math.max(0.25, Math.round((t.wc.getZoomFactor() + delta) * 100) / 100))
    t.wc.setZoomFactor(f)
    this.ctx.push()
  }

  // ---- snapshot ----------------------------------------------------------
  snapshot() {
    const a = this.active
    const nav = a && !a.wc.isDestroyed() ? a.wc.navigationHistory : null
    return {
      tabs: this.list.map((t) => ({
        id: t.id,
        title: t.newTab ? 'New Tab' : t.title || t.url || 'Untitled',
        url: t.url,
        favicon: t.favicon,
        loading: t.loading,
        audible: t.audible,
        muted: t.muted,
      })),
      activeTabId: this.activeId,
      canGoBack: !!nav && nav.canGoBack(),
      canGoForward: !!nav && nav.canGoForward(),
      zoomFactor: a && !a.wc.isDestroyed() ? a.wc.getZoomFactor() : 1,
    }
  }
}

module.exports = { Tabs, NEWTAB_FILE }

import { WebContentsView, shell, type BrowserWindowConstructorOptions, type HandlerDetails, type WebContents, type WindowOpenHandlerResponse } from 'electron'
import { join } from 'node:path'
import type { StageState, SubmitOptions, TabId } from '../shared/contract'
import type { Ctx } from './context'
import { showPageMenu } from './context-menu'
import { addVisit, setHistoryTitle } from './store'
import { isWebUrl } from './url'
import { bgColor } from './window'

export const NEWTAB_FILE = join(__dirname, '..', 'ui', 'newtab.html')
const CLOSED_CAP = 25
const WEB_SCHEMES = new Set(['http:', 'https:', 'file:', 'about:', 'data:', 'blob:', 'chrome-extension:', 'view-source:', 'devtools:', 'chrome:', 'javascript:'])

export interface Tab {
  readonly id: TabId
  readonly view: WebContentsView
  readonly wc: WebContents
  title: string
  url: string
  favicon: string | null
  loading: boolean
  audible: boolean
  muted: boolean
  newTab: boolean
}

export interface CreateTabOptions {
  url?: string | undefined
  activate?: boolean
  index?: number
  // From Electron's window-open path: the view adopts it (keeping window.opener) and Electron
  // drives its first navigation.
  webContents?: WebContents | undefined
}

// Electron hands createWindow the webContents it made for the opener's window.open().
type ChildWindowOptions = BrowserWindowConstructorOptions & { webContents?: WebContents }

type TabsSnapshot = Pick<StageState, 'tabs' | 'activeTabId' | 'canGoBack' | 'canGoForward' | 'zoomFactor'>

function isExternal(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*:)/i.exec(url)?.[1]?.toLowerCase()
  return !!scheme && !WEB_SCHEMES.has(scheme)
}

function openExternal(url: string): void {
  shell.openExternal(url).catch(() => {})
}

export class Tabs {
  readonly list: Tab[] = []
  activeId: TabId | null = null
  private readonly ctx: Ctx
  private readonly closed: string[] = []

  constructor(ctx: Ctx) {
    this.ctx = ctx
  }

  get(id: TabId): Tab | undefined {
    return this.list.find((t) => t.id === id)
  }

  get active(): Tab | undefined {
    return this.list.find((t) => t.id === this.activeId)
  }

  create(opts: CreateTabOptions = {}): Tab {
    const { ctx } = this
    const view = opts.webContents
      ? new WebContentsView({ webContents: opts.webContents })
      : new WebContentsView({ webPreferences: { session: ctx.session, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    view.setBackgroundColor(bgColor())
    const wc = view.webContents
    const tab: Tab = { id: wc.id, view, wc, title: '', url: '', favicon: null, loading: false, audible: false, muted: false, newTab: false }
    this.list.splice(opts.index ?? this.list.length, 0, tab)
    ctx.win.contentView.addChildView(view, 0) // the UI view stays on top
    view.setBounds(ctx.tabBounds())
    view.setVisible(false)
    this.wire(tab)
    ctx.ext.addTab(wc, ctx.win)
    if (!opts.webContents) {
      if (opts.url) this.load(tab, opts.url)
      else this.loadNewTab(tab)
    }
    if (opts.activate !== false) this.activate(tab.id)
    else ctx.push()
    return tab
  }

  private loadNewTab(tab: Tab): void {
    tab.newTab = true
    tab.wc.loadFile(NEWTAB_FILE).catch(() => {})
  }

  private load(tab: Tab, url: string): void {
    tab.newTab = false
    tab.wc.loadURL(url).catch(() => {}) // failures arrive through did-fail-load
  }

  private wire(tab: Tab): void {
    const { wc } = tab
    const push = () => this.ctx.push()
    const syncUrl = () => {
      const u = wc.getURL()
      tab.newTab = u.startsWith('file://') && decodeURI(u).endsWith('/ui/newtab.html')
      tab.url = tab.newTab ? '' : u
    }
    const guardExternal = (e: Electron.Event, url: string) => {
      if (!isExternal(url)) return
      e.preventDefault()
      openExternal(url)
    }

    wc.on('page-title-updated', (_e, title) => {
      tab.title = title
      if (isWebUrl(tab.url)) setHistoryTitle(tab.url, title)
      push()
    })
    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = favicons[0] ?? null
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
      if (isWebUrl(url)) addVisit(url, wc.getTitle())
      this.ctx.saveSession()
      push()
    })
    wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => {
      if (!isMainFrame) return
      syncUrl()
      this.ctx.saveSession()
      push()
    })
    wc.on('audio-state-changed', (e) => {
      tab.audible = e.audible
      push()
    })
    wc.on('zoom-changed', push)
    wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      syncUrl()
      push()
    })
    wc.on('destroyed', () => this.removeDead(tab))
    wc.on('context-menu', (_e, params) => showPageMenu(this.ctx, tab, params))
    wc.on('will-navigate', guardExternal)
    wc.on('will-redirect', guardExternal)
    wc.setWindowOpenHandler((d) => this.openHandler(d))
  }

  openHandler({ url, disposition }: HandlerDetails): WindowOpenHandlerResponse {
    if (isExternal(url)) {
      openExternal(url)
      return { action: 'deny' }
    }
    if (disposition === 'new-window') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: bgColor(), webPreferences: { sandbox: true, contextIsolation: true } },
      }
    }
    return {
      action: 'allow',
      createWindow: ({ webContents }: ChildWindowOptions) =>
        this.create({
          webContents,
          url: webContents ? undefined : url,
          activate: disposition !== 'background-tab',
          index: this.insertIndexAfterActive(),
        }).wc,
    }
  }

  insertIndexAfterActive(): number {
    const i = this.list.findIndex((t) => t.id === this.activeId)
    return i < 0 ? this.list.length : i + 1
  }

  activate(id: TabId): void {
    const tab = this.get(id)
    if (!tab) return
    this.activeId = id
    for (const t of this.list) t.view.setVisible(t === tab)
    tab.view.setBounds(this.ctx.tabBounds())
    this.ctx.ext.selectTab(tab.wc)
    if (!this.ctx.overlay) tab.wc.focus()
    this.ctx.saveSession()
    this.ctx.push()
  }

  focusActive(): void {
    const t = this.active
    if (t && !t.wc.isDestroyed()) t.wc.focus()
  }

  close(id: TabId): void {
    const tab = this.get(id)
    if (!tab) return
    if (isWebUrl(tab.url)) this.closed.push(tab.url)
    if (this.closed.length > CLOSED_CAP) this.closed.shift()
    this.removeFromList(tab)
    this.detach(tab)
    try {
      this.ctx.ext.removeTab(tab.wc)
    } catch {}
    if (!tab.wc.isDestroyed()) tab.wc.close()
  }

  // The webContents went away on its own: window.close() or crash cleanup.
  private removeDead(tab: Tab): void {
    if (!this.get(tab.id)) return
    this.removeFromList(tab)
    this.detach(tab)
  }

  private detach(tab: Tab): void {
    try {
      this.ctx.win.contentView.removeChildView(tab.view)
    } catch {}
  }

  private removeFromList(tab: Tab): void {
    const i = this.list.indexOf(tab)
    if (i < 0) return
    this.list.splice(i, 1)
    if (this.ctx.quitting) return
    const next = this.list[Math.min(i, this.list.length - 1)]
    if (!next) this.create()
    else if (this.activeId === tab.id) this.activate(next.id)
    else {
      this.ctx.saveSession()
      this.ctx.push()
    }
  }

  closeOthers(id: TabId): void {
    for (const t of this.list.filter((x) => x.id !== id)) this.close(t.id)
  }

  closeRight(id: TabId): void {
    const i = this.list.findIndex((t) => t.id === id)
    for (const t of this.list.slice(i + 1)) this.close(t.id)
  }

  reopenClosed(): void {
    const url = this.closed.pop()
    if (url) this.create({ url })
  }

  duplicate(id: TabId): void {
    const t = this.get(id)
    if (!t) return
    this.create({ url: t.url || undefined, index: this.list.indexOf(t) + 1 })
  }

  move(id: TabId, toIndex: number): void {
    const from = this.list.findIndex((t) => t.id === id)
    if (from < 0) return
    const [t] = this.list.splice(from, 1)
    if (!t) return
    this.list.splice(Math.max(0, Math.min(toIndex, this.list.length)), 0, t)
    this.ctx.saveSession()
    this.ctx.push()
  }

  step(delta: number): void {
    const n = this.list.length
    if (n < 2) return
    const i = this.list.findIndex((t) => t.id === this.activeId)
    const t = this.list[(i + delta + n) % n]
    if (t) this.activate(t.id)
  }

  // 1-based; 9 means the last tab.
  goTo(n: number): void {
    const t = n === 9 ? this.list.at(-1) : this.list[n - 1]
    if (t) this.activate(t.id)
  }

  toggleMute(id: TabId): void {
    const t = this.get(id)
    if (!t) return
    t.muted = !t.muted
    t.wc.setAudioMuted(t.muted)
    this.ctx.push()
  }

  open(url: string, { newTab }: SubmitOptions): Tab {
    const t = this.active
    if (newTab || !t) return this.create({ url, index: this.insertIndexAfterActive() })
    this.load(t, url)
    this.activate(t.id)
    return t
  }

  layout(): void {
    const b = this.ctx.tabBounds()
    for (const t of this.list) t.view.setBounds(b)
  }

  zoom(delta: number): void {
    const t = this.active
    if (!t) return
    const f = delta === 0 ? 1 : Math.min(5, Math.max(0.25, Math.round((t.wc.getZoomFactor() + delta) * 100) / 100))
    t.wc.setZoomFactor(f)
    this.ctx.push()
  }

  snapshot(): TabsSnapshot {
    const a = this.active
    const live = a && !a.wc.isDestroyed() ? a.wc : null
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
      canGoBack: !!live && live.navigationHistory.canGoBack(),
      canGoForward: !!live && live.navigationHistory.canGoForward(),
      zoomFactor: live ? live.getZoomFactor() : 1,
    }
  }
}

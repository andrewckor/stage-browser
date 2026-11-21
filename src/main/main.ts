import { app, Menu, nativeImage, type BaseWindow, session as sessions, type Rectangle, type Session, type WebContentsView } from 'electron'
import type { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { appendFileSync, existsSync, mkdtempSync, statSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { channel, type Overlay, type StageState } from '../shared/contract'
import { parseArgs, type LaunchArgs } from './cli-args'
import type { BarFlags, Ctx } from './context'
import { actionCount, createExtensions, setupWebStore } from './extensions'
import { setupIpc } from './ipc'
import { buildMenu } from './menu'
import { Reveal } from './reveal'
import { run as runSelftest } from './selftest'
import { flushHistory, readPrefs, readSession, writePrefs, writeSession, type SavedSession } from './store'
import { Tabs } from './tabs'
import { resolveInput } from './url'
import { BAR_HEIGHT, createWindow, tabBounds, uiBounds } from './window'

const APP_ROOT = resolve(__dirname, '..', '..')
const SELFTEST = !!process.env.STAGE_SELFTEST
const PUSH_MS = 16
const SAVE_MS = 500
const WEB_STORE_TIMEOUT_MS = 5000
const ERROR_LOG_MAX_BYTES = 1_000_000

app.setName('Stage')
if (SELFTEST && !process.env.STAGE_USER_DATA) process.env.STAGE_USER_DATA = mkdtempSync(join(tmpdir(), 'stage-selftest-'))
app.setPath('userData', process.env.STAGE_USER_DATA || join(app.getPath('appData'), 'Stage'))

// Sites like Google and Okta reject "Electron" user agents as embedded browsers.
const cleanUA = (ua: string) => ua.replace(/\s(?:Electron|stage-browser|Stage)\/\S+/gi, '')
app.userAgentFallback = cleanUA(app.userAgentFallback)

function log(msg: string): void {
  const file = process.env.STAGE_LOG
  if (!file) return
  try {
    appendFileSync(file, msg + '\n')
  } catch {}
}

// A modal error dialog in the middle of a live demo is worse than a lost click, so errors go to
// <userData>/stage.log. The selftest records its own.
if (!SELFTEST) {
  const errorLog = join(app.getPath('userData'), 'stage.log')
  const record = (kind: string) => (err: unknown) => {
    const line = `${new Date().toISOString()} ${kind} ${err instanceof Error ? err.stack : String(err)}\n`
    try {
      if (existsSync(errorLog) && statSync(errorLog).size > ERROR_LOG_MAX_BYTES) truncateSync(errorLog, 0)
      appendFileSync(errorLog, line)
    } catch {}
    if (process.stderr.isTTY) process.stderr.write(line)
  }
  process.on('uncaughtException', record('uncaughtException'))
  process.on('unhandledRejection', record('unhandledRejection'))
}

if (!SELFTEST && !app.requestSingleInstanceLock()) app.exit(0)

class Stage implements Ctx {
  readonly session: Session
  readonly win: BaseWindow
  readonly uiView: WebContentsView
  readonly tabs: Tabs
  readonly reveal: Reveal
  readonly ext: ElectronChromeExtensions
  readonly bar: BarFlags = { visible: false, pinned: false, hover: false }
  // Kept apart from session.json so --fresh doesn't reset them.
  readonly prefs = readPrefs()
  overlay: Overlay | null = null
  popupOpen = false
  quitting = false
  holdQuit = false

  private readonly endDrag: () => void
  private pushTimer: ReturnType<typeof setTimeout> | undefined
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private lastSent = ''

  constructor(session: Session, saved: Partial<SavedSession>, args: LaunchArgs) {
    this.session = session
    const { win, uiView } = createWindow(saved.bounds, args.size)
    this.win = win
    this.uiView = uiView
    this.bar.pinned = !!saved.pinned || args.pin
    this.tabs = new Tabs(this)
    this.reveal = new Reveal(this)
    this.ext = createExtensions(this)
    this.endDrag = setupIpc(this)
    this.rebuildMenu()

    uiView.webContents.on('did-finish-load', () => {
      this.lastSent = ''
      this.flush()
    })
    uiView.webContents.loadFile(join(__dirname, '..', 'ui', 'index.html')).catch((e: Error) => console.error('[stage] UI load failed', e.message))

    const relayout = () => {
      if (this.quitting) return
      this.layout()
      this.push()
    }
    win.on('resize', () => {
      relayout()
      this.saveSession()
    })
    win.on('move', () => this.saveSession())
    win.on('enter-full-screen', relayout)
    win.on('leave-full-screen', relayout)
    win.on('close', () => this.shutdown())
    win.on('closed', () => !this.holdQuit && app.quit())
    this.layout()
  }

  private get live(): boolean {
    return !this.quitting && !this.win.isDestroyed()
  }

  tabBounds(): Rectangle {
    return tabBounds(this.win, this.bar.pinned)
  }

  layout(): void {
    if (this.win.isDestroyed() || this.uiView.webContents.isDestroyed()) return
    this.uiView.setBounds(uiBounds(this.win, this.bar.pinned, this.overlay !== null))
    this.tabs.layout()
  }

  getState(): StageState {
    return {
      ...this.tabs.snapshot(),
      bar: { visible: this.bar.visible, pinned: this.bar.pinned },
      hideExtensionIcons: this.prefs.hideExtensionIcons,
      extensionActions: actionCount(this.session),
      overlay: this.overlay,
      barHeight: BAR_HEIGHT,
      fullscreen: !this.win.isDestroyed() && this.win.isFullScreen(),
    }
  }

  flush(): void {
    clearTimeout(this.pushTimer)
    this.pushTimer = undefined
    const wc = this.uiView.webContents
    if (!this.live || wc.isDestroyed() || wc.isLoading()) return
    const state = this.getState()
    const json = JSON.stringify(state)
    if (json === this.lastSent) return
    this.lastSent = json
    wc.send(channel('state'), state)
  }

  push(): void {
    if (this.pushTimer || this.quitting) return
    this.pushTimer = setTimeout(() => this.flush(), PUSH_MS)
  }

  saveSession(): void {
    if (!this.live) return
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.writeSessionNow(), SAVE_MS)
  }

  private writeSessionNow(): void {
    if (!this.live) return
    const { list, activeId } = this.tabs
    const keepBounds = this.win.isFullScreen() || this.win.isMinimized()
    writeSession({
      tabs: list.map((t) => t.url),
      active: Math.max(0, list.findIndex((t) => t.id === activeId)),
      pinned: this.bar.pinned,
      bounds: keepBounds ? readSession().bounds : this.win.getBounds(),
    })
  }

  rebuildMenu(): void {
    Menu.setApplicationMenu(buildMenu(this))
  }

  setHideExtensionIcons(hide: boolean): void {
    this.prefs.hideExtensionIcons = hide
    writePrefs(this.prefs)
    this.push()
    this.rebuildMenu()
  }

  applyArgs(args: LaunchArgs, initial: boolean): void {
    log('args ' + JSON.stringify(args))
    if (args.size && !initial) {
      this.win.setContentSize(args.size.width, args.size.height)
      this.win.center()
    }
    if (args.pin && !initial) this.reveal.setPinned(true)
    const urls = args.urls.map(resolveInput).filter((u): u is string => u !== null)
    // The first launch keeps the first tab active; later invocations jump to the newest.
    urls.forEach((url, i) => this.tabs.create({ url, activate: initial ? i === 0 : i === urls.length - 1 }))
  }

  restore(saved: Partial<SavedSession>, args: LaunchArgs): void {
    if (args.urls.some((u) => resolveInput(u))) return this.applyArgs(args, true)
    const urls = saved.tabs ?? []
    if (!urls.length) return void this.tabs.create()
    for (const url of urls) this.tabs.create({ url: url || undefined, activate: false })
    const { list } = this.tabs
    const target = list[Math.min(saved.active ?? 0, list.length - 1)]
    if (target) this.tabs.activate(target.id)
  }

  // Writes what must survive, then stops every timer so nothing touches the window afterwards.
  shutdown(): void {
    if (this.quitting) return
    this.writeSessionNow()
    flushHistory()
    this.quitting = true
    clearTimeout(this.pushTimer)
    clearTimeout(this.saveTimer)
    this.endDrag()
    this.reveal.stop()
  }
}

function setupDownloads(session: Session): void {
  session.on('will-download', (_e, item) => {
    const dir = app.getPath('downloads')
    const name = item.getFilename()
    const ext = extname(name)
    const base = basename(name, ext)
    let target = join(dir, name)
    for (let n = 1; existsSync(target); n++) target = join(dir, `${base} (${n})${ext}`)
    item.setSavePath(target)
    item.once('done', (_ev, state) => {
      if (state === 'completed') app.dock?.downloadFinished(target)
    })
  })
}

let stage: Stage | undefined

async function boot(): Promise<void> {
  const session = sessions.fromPartition('persist:stage')
  session.setUserAgent(cleanUA(session.getUserAgent()))
  setupDownloads(session)

  const args: LaunchArgs = SELFTEST ? { urls: [], size: null, pin: false, fresh: true } : parseArgs(process.argv, APP_ROOT)
  const saved = args.fresh ? {} : readSession()

  const icon = join(APP_ROOT, 'build', 'icon.png')
  if (app.dock && existsSync(icon)) app.dock.setIcon(nativeImage.createFromPath(icon))

  const s = new Stage(session, saved, args)
  stage = s

  // Load installed extensions before the first page so content scripts attach to it.
  const timeout = new Promise<void>((r) => setTimeout(r, WEB_STORE_TIMEOUT_MS))
  await Promise.race([setupWebStore(s).catch((e: Error) => console.error('[stage] web store setup failed', e.message)), timeout])
  s.rebuildMenu()

  s.win.show()
  s.reveal.syncPolling()
  if (s.bar.pinned) {
    s.reveal.show()
    s.rebuildMenu()
  }

  if (SELFTEST) return void runSelftest(s)
  s.restore(saved, args)
  log('ready tabs=' + s.tabs.list.length)
}

app.on('second-instance', (_e, argv) => {
  if (!stage || stage.win.isDestroyed()) return
  const { win } = stage
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  app.focus({ steal: true })
  stage.applyArgs(parseArgs(argv, APP_ROOT), false)
})

app.on('before-quit', () => stage?.shutdown())
app.on('window-all-closed', () => !stage?.holdQuit && app.quit())

app
  .whenReady()
  .then(boot)
  .catch((e: unknown) => {
    console.error('[stage] boot failed', e)
    app.exit(1)
  })

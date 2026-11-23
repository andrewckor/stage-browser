import { app, Menu, nativeImage, type BaseWindow, session as sessions, type Rectangle, type Session } from 'electron'
import type { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { appendFileSync, existsSync, mkdtempSync, statSync, truncateSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { channel, type Overlay, type StageState, type TabLayout } from '../shared/contract'
import { appArgs, parseArgs, readHandoff, type Handoff, type LaunchArgs } from './cli-args'
import type { BarFlags, Ctx } from './context'
import { actionCount, createExtensions, setupExtensionStore } from './extensions'
import { setupGoogleSignIn } from './google-sign-in'
import { setupIpc } from './ipc'
import { buildMenu } from './menu'
import { Reveal } from './reveal'
import { flushHistory, readPrefs, readSession, writePrefs, writeSession, type SavedSession } from './store'
import { Tabs } from './tabs'
import { UiWindow } from './ui-window'
import { restartWarnings, trackDownload } from './restart-warnings'
import { Updates } from './updates'
import { resolveInput } from './url'
import { BAR_HEIGHT, createWindow, SIDEBAR_WIDTH, tabBounds, uiBounds, WindowDrag } from './window'
import { versionOf } from '../update/common'
import { QUIT_RUNNING } from '../update/launcher'
import { clearRunning, writeRunning } from '../update/running'

const APP_ROOT = resolve(__dirname, '..', '..')
// Read once: an update can replace the files under a running Stage.
const VERSION = versionOf(APP_ROOT)
const QUIT_FOR_RESTART_MS = 5000
const FLUSH_COOKIES_MS = 2000
const SELFTEST = !!process.env.STAGE_SELFTEST
const PUSH_MS = 16
const SAVE_MS = 500
const EXTENSIONS_TIMEOUT_MS = 5000
const ERROR_LOG_MAX_BYTES = 1_000_000

app.setName('Stage')
if (SELFTEST && !process.env.STAGE_USER_DATA) process.env.STAGE_USER_DATA = mkdtempSync(join(tmpdir(), 'stage-selftest-'))
app.setPath('userData', process.env.STAGE_USER_DATA ? resolve(process.env.STAGE_USER_DATA) : join(app.getPath('appData'), 'Stage'))
const USER_DATA = app.getPath('userData')
// Resolved now: boot leaves the package folder, which an update may move.
const LOG_FILE = process.env.STAGE_LOG && resolve(process.env.STAGE_LOG)

// Sites like Google and Okta reject "Electron" user agents as embedded browsers.
const cleanUA = (ua: string) => ua.replace(/\s(?:Electron|stage-browser|Stage)\/\S+/gi, '')
app.userAgentFallback = cleanUA(app.userAgentFallback)

function log(msg: string): void {
  if (!LOG_FILE) return
  try {
    appendFileSync(LOG_FILE, msg + '\n')
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

const launch: LaunchArgs = SELFTEST ? { urls: [], size: null, pin: false, fresh: true } : parseArgs(process.argv, APP_ROOT)
// Only first, the way the launcher passes it: `stage <url> --quit-running` is not a quit request.
const asksToQuit = !SELFTEST && appArgs(process.argv, APP_ROOT)[0] === QUIT_RUNNING
const handoff: Handoff = { args: launch, quit: asksToQuit }
const primary = SELFTEST || app.requestSingleInstanceLock({ ...handoff })
// A quit request that got the lock found no Stage to quit.
const runs = primary && !asksToQuit
if (!runs) app.exit(0)

class Stage implements Ctx {
  readonly session: Session
  readonly win: BaseWindow
  readonly ui: UiWindow
  readonly drag: WindowDrag
  readonly tabs: Tabs
  readonly reveal: Reveal
  readonly ext: ElectronChromeExtensions
  readonly bar: BarFlags = { visible: false, pinned: false, hover: false }
  // Kept apart from session.json so --fresh doesn't reset them.
  readonly prefs = readPrefs()
  readonly updates: Updates
  overlay: Overlay | null = null
  popupOpen = false
  quitting = false
  holdQuit = false
  // Until the saved tabs are back, saving would write an empty list over them.
  private restored = SELFTEST

  private pushTimer: ReturnType<typeof setTimeout> | undefined
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private lastSent = ''

  constructor(session: Session, saved: Partial<SavedSession>, args: LaunchArgs) {
    this.session = session
    const win = createWindow(saved.bounds, args.size)
    this.win = win
    this.ui = new UiWindow(win)
    this.drag = new WindowDrag(win)
    this.bar.pinned = !!saved.pinned || args.pin
    this.tabs = new Tabs(this)
    this.reveal = new Reveal(this)
    this.ext = createExtensions(this)
    this.updates = new Updates(this, { root: APP_ROOT, version: VERSION, userData: USER_DATA, quit: () => void quitForRestart(), warnings: () => restartWarnings(this) })
    setupIpc(this)
    this.rebuildMenu()

    const ui = this.ui.view.webContents
    ui.on('did-finish-load', () => {
      this.lastSent = ''
      this.flush()
    })
    ui.loadFile(join(__dirname, '..', 'ui', 'index.html')).catch((e: Error) => console.error('[stage] UI load failed', e.message))

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
    return tabBounds(this.win)
  }

  layout(): void {
    if (this.win.isDestroyed() || this.ui.win.isDestroyed()) return
    this.ui.setBounds(uiBounds(this.win, this.prefs.tabLayout, this.bar.pinned, this.overlay !== null))
    this.tabs.layout()
  }

  getState(): StageState {
    return {
      ...this.tabs.snapshot(),
      bar: { visible: this.bar.visible, pinned: this.bar.pinned },
      hideExtensionIcons: this.prefs.hideExtensionIcons,
      extensionActions: actionCount(this.session),
      overlay: this.overlay,
      update: this.updates.state(),
      barHeight: BAR_HEIGHT,
      tabLayout: this.prefs.tabLayout,
      sidebarWidth: SIDEBAR_WIDTH,
      fullscreen: !this.win.isDestroyed() && this.win.isFullScreen(),
    }
  }

  flush(): void {
    clearTimeout(this.pushTimer)
    this.pushTimer = undefined
    const wc = this.ui.view.webContents
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
    if (!this.live || !this.restored) return
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

  setCheckForUpdates(check: boolean): void {
    this.prefs.checkForUpdates = check
    writePrefs(this.prefs)
    this.rebuildMenu()
  }

  setTabLayout(layout: TabLayout): void {
    if (this.prefs.tabLayout !== layout) {
      this.prefs.tabLayout = layout
      writePrefs(this.prefs)
      this.reveal.relayout()
    }
    this.rebuildMenu() // the radio items follow the pref even when a click re-picked the current one
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
    this.openFirstTabs(saved, args)
    this.restored = true
  }

  private openFirstTabs(saved: Partial<SavedSession>, args: LaunchArgs): void {
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
    this.drag.end()
    this.reveal.stop()
    this.updates.stop()
  }
}

function setupDownloads(session: Session): void {
  session.on('will-download', (_e, item) => {
    trackDownload(item)
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
let quittingForRestart = false

// An update or `stage --restart` is waiting for this process to end.
async function quitForRestart(): Promise<void> {
  if (quittingForRestart) return
  quittingForRestart = true
  // A popup's beforeunload can veto a quit; everything worth keeping is written by then.
  setTimeout(() => {
    clearRunning(USER_DATA)
    app.exit(0)
  }, QUIT_FOR_RESTART_MS)
  if (stage) {
    stage.shutdown()
    const { session } = stage
    session.flushStorageData()
    await Promise.race([session.cookies.flushStore().catch(() => {}), new Promise((r) => setTimeout(r, FLUSH_COOKIES_MS))])
  }
  app.quit()
}

async function boot(): Promise<void> {
  if (!runs || quittingForRestart) return
  if (!SELFTEST) {
    writeRunning(USER_DATA, VERSION, false)
    // Neither an update nor npx replacing the package should leave Stage in a deleted folder.
    process.chdir(homedir())
  }
  app.setAboutPanelOptions({ applicationName: 'Stage', applicationVersion: VERSION, version: '' })
  const session = sessions.fromPartition('persist:stage')
  session.setUserAgent(cleanUA(session.getUserAgent()))
  setupGoogleSignIn(session)
  setupDownloads(session)

  const saved = launch.fresh ? {} : readSession()

  const icon = join(APP_ROOT, 'build', 'icon.png')
  if (app.dock && existsSync(icon)) app.dock.setIcon(nativeImage.createFromPath(icon))

  const s = new Stage(session, saved, launch)
  stage = s

  // Load installed extensions before the first page so content scripts attach to it.
  const timeout = new Promise<void>((r) => setTimeout(r, EXTENSIONS_TIMEOUT_MS))
  await Promise.race([setupExtensionStore(s).catch((e: Error) => console.error('[stage] extension setup failed', e.message)), timeout])
  if (s.quitting) return
  s.rebuildMenu()

  s.win.show()
  s.reveal.syncPolling()
  if (s.bar.pinned) {
    s.reveal.show()
    s.rebuildMenu()
  }

  // Loaded only here: the selftest is left out of the published package.
  if (SELFTEST) return void (require('./selftest') as typeof import('./selftest')).run(s)
  s.restore(saved, launch)
  writeRunning(USER_DATA, VERSION, true)
  s.updates.start()
  log('ready tabs=' + s.tabs.list.length)
}

app.on('second-instance', (_e, argv, _cwd, data) => {
  const { args, quit } = readHandoff(argv, data)
  if (quit) return void quitForRestart()
  if (!stage || stage.quitting || stage.win.isDestroyed()) return
  const { win } = stage
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  app.focus({ steal: true })
  stage.applyArgs(args, false)
})

app.on('before-quit', () => stage?.shutdown())
app.on('will-quit', () => {
  if (runs && !SELFTEST) clearRunning(USER_DATA)
})
app.on('window-all-closed', () => !stage?.holdQuit && app.quit())

app
  .whenReady()
  .then(boot)
  .catch((e: unknown) => {
    console.error('[stage] boot failed', e)
    app.exit(1)
  })

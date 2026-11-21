'use strict'
const path = require('path')
const fs = require('fs')
const { app, ipcMain, nativeImage, screen, session } = require('electron')

// ---- profile and identity: must happen before `ready` ----------------------
app.setName('Stage')
if (process.env.STAGE_SELFTEST && !process.env.STAGE_USER_DATA) {
  process.env.STAGE_USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'stage-selftest-'))
}
app.setPath('userData', process.env.STAGE_USER_DATA || path.join(app.getPath('appData'), 'Stage'))

// Sites like Google and Okta reject "Electron" user agents as embedded browsers.
const cleanUA = (ua) => ua.replace(/\s(?:Electron|stage-browser|Stage)\/\S+/gi, '')
app.userAgentFallback = cleanUA(app.userAgentFallback)

const { parseArgs } = require('./cli-args')
const { resolveInput } = require('./url')
const store = require('./store')
const { createWindow, bgColor, BAR_HEIGHT } = require('./window')
const { Tabs } = require('./tabs')
const { Reveal } = require('./reveal')
const { suggest } = require('./suggest')
const { showTabMenu } = require('./context-menu')
const { installMenu } = require('./menu')
const extensions = require('./extensions')

const APP_ROOT = path.resolve(__dirname, '..', '..')
const SELFTEST = !!process.env.STAGE_SELFTEST
const log = (msg) => {
  if (process.env.STAGE_LOG) {
    try {
      fs.appendFileSync(process.env.STAGE_LOG, msg + '\n')
    } catch {}
  }
}

// A modal error dialog in the middle of a live demo is worse than a lost click, so errors go
// to <userData>/stage.log instead. The selftest installs its own handler to record them.
if (!SELFTEST) {
  const errorLog = path.join(app.getPath('userData'), 'stage.log')
  const record = (kind) => (err) => {
    const line = `${new Date().toISOString()} ${kind} ${(err && err.stack) || err}\n`
    try {
      if (fs.existsSync(errorLog) && fs.statSync(errorLog).size > 1_000_000) fs.truncateSync(errorLog, 0)
      fs.appendFileSync(errorLog, line)
    } catch {}
    if (process.stderr.isTTY) process.stderr.write(line)
  }
  process.on('uncaughtException', record('uncaughtException'))
  process.on('unhandledRejection', record('unhandledRejection'))
}

const ctx = {
  session: null,
  win: null,
  uiView: null,
  tabs: null,
  reveal: null,
  ext: null,
  bar: { visible: false, pinned: false, hover: false },
  // Display preferences, kept apart from session.json so `--fresh` doesn't reset them.
  prefs: { hideExtensionIcons: false, ...store.readJson('prefs.json', {}) },
  overlay: null,
  popupOpen: false,
  quitting: false,
  bgColor,
  log,
}

if (!SELFTEST && !app.requestSingleInstanceLock()) {
  app.exit(0)
}

ctx.setHideExtensionIcons = (hide) => {
  ctx.prefs.hideExtensionIcons = !!hide
  store.writeJson('prefs.json', ctx.prefs)
  ctx.push()
  ctx.rebuildMenu && ctx.rebuildMenu()
}

// ---- state hub: coalesced pushes to the UI ------------------------------------
let pushTimer = null
let lastSent = ''
ctx.getState = () => ({
  ...ctx.tabs.snapshot(),
  bar: { visible: ctx.bar.visible, pinned: ctx.bar.pinned },
  hideExtensionIcons: !!ctx.prefs.hideExtensionIcons,
  extensionActions: extensions.actionCount(ctx),
  overlay: ctx.overlay,
  barHeight: BAR_HEIGHT,
  fullscreen: !!ctx.win && !ctx.win.isDestroyed() && ctx.win.isFullScreen(),
})
ctx.flush = () => {
  clearTimeout(pushTimer)
  pushTimer = null
  if (ctx.quitting || !ctx.win || ctx.win.isDestroyed()) return
  if (!ctx.uiView || ctx.uiView.webContents.isDestroyed() || ctx.uiView.webContents.isLoading()) return
  const s = ctx.getState()
  const j = JSON.stringify(s)
  if (j === lastSent) return
  lastSent = j
  ctx.uiView.webContents.send('stage:state', s)
}
ctx.push = () => {
  if (pushTimer || ctx.quitting) return
  pushTimer = setTimeout(ctx.flush, 16)
}

// ---- session persistence ---------------------------------------------------------
let saveTimer = null
const writeSession = () => {
  if (ctx.quitting || !ctx.tabs || !ctx.win || ctx.win.isDestroyed()) return
  const urls = ctx.tabs.list.map((t) => t.url)
  const active = Math.max(0, ctx.tabs.list.findIndex((t) => t.id === ctx.tabs.activeId))
  const prev = store.readJson('session.json', {})
  const bounds = ctx.win.isFullScreen() || ctx.win.isMinimized() ? prev.bounds : ctx.win.getBounds()
  store.writeJson('session.json', { tabs: urls, active, pinned: ctx.bar.pinned, bounds })
}
ctx.saveSession = () => {
  if (ctx.quitting || !ctx.win || ctx.win.isDestroyed()) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(writeSession, 500)
}

// Stop every timer so nothing touches the window after teardown begins.
ctx.teardown = () => {
  ctx.quitting = true
  clearTimeout(pushTimer)
  pushTimer = null
  clearTimeout(saveTimer)
  saveTimer = null
  endDrag()
  if (ctx.reveal) ctx.reveal.stop()
}

// ---- args ------------------------------------------------------------------------
function applyArgs(args, { initial = false } = {}) {
  log('args ' + JSON.stringify(args))
  if (args.size) {
    ctx.win.setContentSize(args.size.width, args.size.height)
    ctx.win.center()
  }
  if (args.pin) ctx.reveal.setPinned(true)
  const urls = args.urls.map(resolveInput).filter(Boolean)
  urls.forEach((u, i) => {
    // initial launch keeps the first tab active; later invocations jump to the newest
    ctx.tabs.create({ url: u, activate: initial ? i === 0 : i === urls.length - 1 })
  })
}

// ---- downloads -----------------------------------------------------------------
function setupDownloads() {
  ctx.session.on('will-download', (_e, item) => {
    const dir = app.getPath('downloads')
    const ext = path.extname(item.getFilename())
    const base = path.basename(item.getFilename(), ext)
    let target = path.join(dir, item.getFilename())
    for (let n = 1; fs.existsSync(target); n++) target = path.join(dir, `${base} (${n})${ext}`)
    item.setSavePath(target)
    item.once('done', (_ev, state) => {
      if (state === 'completed' && app.dock) app.dock.downloadFinished(target)
    })
  })
}

// ---- IPC -------------------------------------------------------------------------
let endDrag = () => {}
function setupIpc() {
  const fromUI = (e) => ctx.uiView && e.sender === ctx.uiView.webContents
  const on = (ch, fn) => ipcMain.on(ch, (e, ...a) => fromUI(e) && fn(...a))
  ipcMain.handle('stage:getState', (e) => (fromUI(e) ? ctx.getState() : null))
  ipcMain.handle('stage:suggest', (e, q) => (fromUI(e) ? suggest(ctx, q) : []))

  on('stage:activateTab', (id) => ctx.tabs.activate(id))
  on('stage:closeTab', (id) => ctx.tabs.close(id))
  on('stage:moveTab', (id, i) => ctx.tabs.move(id, i))
  on('stage:showTabMenu', (id) => showTabMenu(ctx, id))
  on('stage:openOmnibox', (mode) => ctx.reveal.openOverlay(mode === 'edit' ? 'edit' : 'new', mode === 'edit' && ctx.tabs.active ? ctx.tabs.active.url : ''))
  on('stage:closeOverlay', () => ctx.reveal.closeOverlay())
  on('stage:submitOmnibox', (input, opts) => {
    const url = resolveInput(input)
    ctx.reveal.closeOverlay(false)
    if (url) ctx.tabs.open(url, { newTab: !!(opts && opts.newTab) })
    ctx.tabs.focusActive()
  })
  on('stage:back', () => ctx.tabs.active && ctx.tabs.active.wc.navigationHistory.goBack())
  on('stage:forward', () => ctx.tabs.active && ctx.tabs.active.wc.navigationHistory.goForward())
  on('stage:reload', () => ctx.tabs.active && ctx.tabs.active.wc.reload())
  on('stage:setBarHover', (h) => ctx.reveal.setHover(h))
  on('stage:passClick', (x, y, button, clickCount) => {
    const tab = ctx.tabs.active
    if (!tab || tab.wc.isDestroyed() || ![x, y].every(Number.isFinite)) return
    ctx.reveal.hideNow()
    const ev = {
      x: Math.round(x),
      y: Math.round(y - ctx.tabBounds().y),
      button: ['left', 'middle', 'right'][button] || 'left',
      clickCount: Math.min(3, Math.max(1, Number(clickCount) || 1)),
    }
    tab.wc.focus()
    tab.wc.sendInputEvent({ type: 'mouseDown', ...ev })
    tab.wc.sendInputEvent({ type: 'mouseUp', ...ev })
  })

  // Window drag fallback: move the window by the cursor delta while the UI holds the mouse down.
  let drag = null
  endDrag = () => {
    if (drag) clearInterval(drag.timer)
    drag = null
  }
  on('stage:startWindowDrag', () => {
    if (drag || ctx.win.isFullScreen()) return
    const p0 = screen.getCursorScreenPoint()
    const [x0, y0] = ctx.win.getPosition()
    const started = Date.now()
    drag = {
      timer: setInterval(() => {
        if (Date.now() - started > 60000) return endDrag()
        if (ctx.win.isDestroyed()) return endDrag()
        const p = screen.getCursorScreenPoint()
        ctx.win.setPosition(x0 + p.x - p0.x, y0 + p.y - p0.y)
      }, 8),
    }
  })
  on('stage:endWindowDrag', endDrag)
}

// ---- boot --------------------------------------------------------------------------
async function boot() {
  ctx.session = session.fromPartition('persist:stage')
  ctx.session.setUserAgent(cleanUA(ctx.session.getUserAgent()))
  setupDownloads()

  const args = parseArgs(process.argv, APP_ROOT)
  if (SELFTEST) {
    args.fresh = true
    args.urls = []
    args.size = null
    args.pin = false
  }
  const saved = args.fresh ? {} : store.readJson('session.json', {})

  if (app.dock) {
    const icon = path.join(__dirname, '..', '..', 'build', 'icon.png')
    if (fs.existsSync(icon)) app.dock.setIcon(nativeImage.createFromPath(icon))
  }

  createWindow(ctx, saved.bounds, args.size)
  ctx.bar.pinned = !!saved.pinned || args.pin
  ctx.tabs = new Tabs(ctx)
  ctx.reveal = new Reveal(ctx)
  ctx.ext = extensions.createExtensions(ctx)
  setupIpc()
  installMenu(ctx)

  const { win, uiView } = ctx
  uiView.webContents.on('did-finish-load', () => {
    lastSent = ''
    ctx.flush()
  })
  uiView.webContents.loadFile(path.join(__dirname, '..', 'ui', 'index.html')).catch((e) => console.error('[stage] UI load failed', e.message))

  const relayout = () => {
    if (ctx.quitting) return
    ctx.layout()
    ctx.push()
  }
  win.on('resize', () => {
    relayout()
    ctx.saveSession()
  })
  win.on('move', ctx.saveSession)
  win.on('enter-full-screen', relayout)
  win.on('leave-full-screen', relayout)
  win.on('close', () => {
    writeSession()
    store.flushHistory()
    ctx.teardown()
  })
  win.on('closed', () => !ctx.holdQuit && app.quit())
  ctx.layout()

  // Load installed extensions before the first page so content scripts attach to it.
  await Promise.race([extensions.setupWebStore(ctx).catch((e) => console.error('[stage] web store setup failed', e.message)), new Promise((r) => setTimeout(r, 5000))])
  ctx.rebuildMenu()

  win.show()
  ctx.reveal.syncPolling()
  if (ctx.bar.pinned) {
    ctx.reveal.show()
    ctx.rebuildMenu()
  }

  if (SELFTEST) {
    require('./selftest').run(ctx)
    return
  }

  const first = args.urls.map(resolveInput).filter(Boolean)
  if (first.length) {
    applyArgs({ ...args, pin: false, size: null }, { initial: true })
  } else if (saved.tabs && saved.tabs.length) {
    saved.tabs.forEach((u, i) => ctx.tabs.create(u ? { url: u, activate: false } : { activate: false }))
    ctx.tabs.activate(ctx.tabs.list[Math.min(saved.active || 0, ctx.tabs.list.length - 1)].id)
  } else {
    ctx.tabs.create({})
  }
  log('ready tabs=' + ctx.tabs.list.length)
}

app.on('second-instance', (_e, argv) => {
  if (!ctx.win || ctx.win.isDestroyed()) return
  if (ctx.win.isMinimized()) ctx.win.restore()
  ctx.win.show()
  ctx.win.focus()
  app.focus({ steal: true })
  applyArgs(parseArgs(argv, APP_ROOT))
})

app.on('before-quit', () => {
  writeSession()
  store.flushHistory()
  ctx.teardown()
})

app.on('window-all-closed', () => !ctx.holdQuit && app.quit())

app.whenReady().then(boot).catch((e) => {
  console.error('[stage] boot failed', e)
  app.exit(1)
})

module.exports = ctx

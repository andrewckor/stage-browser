import { BaseWindow, nativeTheme, screen, systemPreferences, type Rectangle } from 'electron'
import type { TabLayout, WindowAction } from '../shared/contract'
import type { Size } from './cli-args'

export const BAR_HEIGHT = 52
// The sidebar layout's strip: full height, this wide (8px gutters included).
export const SIDEBAR_WIDTH = 248
// Transparent room under the floating bar so the capsule's shadow isn't clipped. The UI window lets
// the mouse through to the page there. Not used when pinned: the bar then stays up all the time, so
// it keeps to the strip.
export const SHADOW_ROOM = 20
const DRAG_TICK_MS = 8
const DRAG_MAX_MS = 60_000
const EMPTY: Rectangle = { x: 0, y: 0, width: 0, height: 0 }

export function bgColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff'
}

function initialBounds(saved: Rectangle | undefined): Partial<Rectangle> & Size {
  if (!saved?.width || !saved.height) return { width: 1280, height: 800 }
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) => {
    return saved.x < a.x + a.width - 40 && saved.x + saved.width > a.x + 40 && saved.y >= a.y - 10 && saved.y < a.y + a.height - 40
  })
  return onScreen ? saved : { width: saved.width, height: saved.height }
}

// The page window: only tab views live in it, so a single-window share shows nothing else.
export function createWindow(saved: Rectangle | undefined, size: Size | null): BaseWindow {
  const win = new BaseWindow({
    ...initialBounds(saved),
    useContentSize: size !== null,
    minWidth: 480,
    minHeight: 320,
    show: false,
    titleBarStyle: 'hidden',
    backgroundColor: bgColor(),
  })
  if (size) {
    win.setContentSize(size.width, size.height)
    win.center()
  }
  // The native traffic lights are part of this window, so a window share would show them. The UI
  // draws its own in the bar instead.
  win.setWindowButtonVisibility(false)
  return win
}

export function tabBounds(win: BaseWindow): Rectangle {
  if (win.isDestroyed()) return EMPTY
  const [w = 0, h = 0] = win.getContentSize()
  return { x: 0, y: 0, width: w, height: h }
}

// The UI window's bounds, relative to the page window's content area.
export function uiBounds(win: BaseWindow, layout: TabLayout, pinned: boolean, overlay: boolean): Rectangle {
  const [w = 0, h = 0] = win.getContentSize()
  if (overlay) return { x: 0, y: 0, width: w, height: h }
  if (layout === 'top') return { x: 0, y: 0, width: w, height: pinned ? BAR_HEIGHT : BAR_HEIGHT + SHADOW_ROOM }
  // The shadow room is on the page side of the sidebar.
  const width = Math.min(w, pinned ? SIDEBAR_WIDTH : SIDEBAR_WIDTH + SHADOW_ROOM)
  return { x: layout === 'left' ? 0 : w - width, y: 0, width, height: h }
}

function toggleZoom(win: BaseWindow): void {
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
}

// What a title bar double-click does, per System Settings → Desktop & Dock.
function titleBarDoubleClick(win: BaseWindow): void {
  const pref = systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string')
  if (pref === 'None') return
  if (pref === 'Minimize') win.minimize()
  else toggleZoom(win)
}

// The bar's drawn traffic lights and title-bar double-click, with macOS semantics: green toggles
// full screen, Option-green zooms.
export function windowAction(win: BaseWindow, action: WindowAction): void {
  if (win.isDestroyed()) return
  const full = win.isFullScreen()
  if (action === 'close') return win.close()
  if (action === 'fullscreen') return win.setFullScreen(!full)
  if (full) return // minimize and zoom don't apply to a full-screen window
  if (action === 'minimize') win.minimize()
  else if (action === 'zoom') toggleZoom(win)
  else if (action === 'double-click') titleBarDoubleClick(win)
}

// Moves the page window with the cursor while the bar holds the mouse down. The bar lives in a
// child window, so -webkit-app-region would drag only the child; macOS then moves the child along
// with its parent, so the bar can't lag behind.
export class WindowDrag {
  private readonly win: BaseWindow
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(win: BaseWindow) {
    this.win = win
  }

  get active(): boolean {
    return this.timer !== undefined
  }

  start(): void {
    const { win } = this
    if (this.timer || win.isDestroyed() || win.isFullScreen()) return
    const p0 = screen.getCursorScreenPoint()
    const [x0 = 0, y0 = 0] = win.getPosition()
    const started = Date.now()
    let last = `${x0},${y0}`
    // A lost mouse-up can't leave the window stuck to the cursor for more than DRAG_MAX_MS.
    this.timer = setInterval(() => {
      if (Date.now() - started > DRAG_MAX_MS || win.isDestroyed()) return this.end()
      const p = screen.getCursorScreenPoint()
      const x = x0 + p.x - p0.x
      const y = y0 + p.y - p0.y
      if (`${x},${y}` === last) return
      last = `${x},${y}`
      win.setPosition(x, y)
    }, DRAG_TICK_MS)
  }

  end(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }
}

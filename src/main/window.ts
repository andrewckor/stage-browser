import { BaseWindow, WebContentsView, nativeTheme, screen, session, type Rectangle } from 'electron'
import { join } from 'node:path'
import type { Size } from './cli-args'

export const BAR_HEIGHT = 52
// Transparent room under the floating bar so the capsule's shadow isn't clipped. Clicks in it are
// passed to the page. Not used when pinned: the page then starts right under the strip.
const SHADOW_ROOM = 20
const TRAFFIC_LIGHTS = { x: 20, y: 19 }
const EMPTY: Rectangle = { x: 0, y: 0, width: 0, height: 0 }

export interface StageWindow {
  win: BaseWindow
  uiView: WebContentsView
}

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

export function createWindow(saved: Rectangle | undefined, size: Size | null): StageWindow {
  const win = new BaseWindow({
    ...initialBounds(saved),
    useContentSize: size !== null,
    minWidth: 480,
    minHeight: 320,
    show: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: TRAFFIC_LIGHTS,
    backgroundColor: bgColor(),
  })
  if (size) {
    win.setContentSize(size.width, size.height)
    win.center()
  }
  win.setWindowButtonVisibility(false)

  const uiView = new WebContentsView({
    webPreferences: {
      // Non-persistent: it only serves the local UI. Extension icons load over crx://.
      session: session.fromPartition('stage-ui'),
      preload: join(__dirname, '..', 'preload', 'ui-preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  })
  uiView.setBackgroundColor('#00000000')
  uiView.setVisible(false)
  win.contentView.addChildView(uiView)
  return { win, uiView }
}

export function tabBounds(win: BaseWindow, pinned: boolean): Rectangle {
  if (win.isDestroyed()) return EMPTY
  const [w = 0, h = 0] = win.getContentSize()
  const top = pinned ? BAR_HEIGHT : 0
  return { x: 0, y: top, width: w, height: Math.max(0, h - top) }
}

export function uiBounds(win: BaseWindow, pinned: boolean, overlay: boolean): Rectangle {
  const [w = 0, h = 0] = win.getContentSize()
  return { x: 0, y: 0, width: w, height: overlay ? h : pinned ? BAR_HEIGHT : BAR_HEIGHT + SHADOW_ROOM }
}

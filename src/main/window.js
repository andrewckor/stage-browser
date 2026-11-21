'use strict'
const path = require('path')
const { BaseWindow, WebContentsView, nativeTheme, screen, session } = require('electron')

const BAR_HEIGHT = 52
// Transparent room under the floating bar so the capsule's shadow isn't clipped by the view's edge.
// Not used when pinned: then the page starts right under the strip. Clicks in it are passed to the page.
const SHADOW_ROOM = 20
const TRAFFIC_LIGHTS = { x: 20, y: 19 } // 52px strip, 14px buttons -> centered

function bgColor() {
  return nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff'
}

function createWindow(ctx, saved, size) {
  let bounds = { width: 1280, height: 800 }
  if (saved && saved.width && saved.height) {
    // only restore if it still lands on a display
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return saved.x < a.x + a.width - 40 && saved.x + saved.width > a.x + 40 && saved.y >= a.y - 10 && saved.y < a.y + a.height - 40
    })
    bounds = onScreen ? saved : { width: saved.width, height: saved.height }
  }

  const win = new BaseWindow({
    ...bounds,
    useContentSize: !!size,
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
      // separate, non-persistent session: it only serves the local UI; extension icons load via crx://
      session: session.fromPartition('stage-ui'),
      preload: path.join(__dirname, '..', 'preload', 'ui-preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  })
  uiView.setBackgroundColor('#00000000')
  uiView.setVisible(false)
  win.contentView.addChildView(uiView)

  ctx.win = win
  ctx.uiView = uiView

  ctx.tabBounds = () => {
    if (win.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 }
    const [w, h] = win.getContentSize()
    const top = ctx.bar.pinned ? BAR_HEIGHT : 0
    return { x: 0, y: top, width: w, height: Math.max(0, h - top) }
  }
  ctx.layout = () => {
    if (win.isDestroyed() || uiView.webContents.isDestroyed()) return
    const [w, h] = win.getContentSize()
    const barViewHeight = ctx.bar.pinned ? BAR_HEIGHT : BAR_HEIGHT + SHADOW_ROOM
    uiView.setBounds(ctx.overlay ? { x: 0, y: 0, width: w, height: h } : { x: 0, y: 0, width: w, height: barViewHeight })
    ctx.tabs && ctx.tabs.layout()
  }
  return win
}

module.exports = { createWindow, bgColor, BAR_HEIGHT }

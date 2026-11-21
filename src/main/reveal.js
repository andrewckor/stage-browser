'use strict'
const { screen } = require('electron')
const { BAR_HEIGHT } = require('./window')

const POLL_MS = 60
const REVEAL_PX = 6
const HIDE_BELOW = BAR_HEIGHT + 24
const HIDE_DELAY = 350
const VIEW_HIDE_DELAY = 180

class Reveal {
  constructor(ctx) {
    this.ctx = ctx
    this.timer = null
    this.viewTimer = null
    this.awaySince = null
    const { win } = ctx
    const sync = () => this.syncPolling()
    for (const ev of ['show', 'hide', 'minimize', 'restore']) win.on(ev, sync)
  }

  syncPolling() {
    const { win } = this.ctx
    const should = !this.ctx.quitting && !win.isDestroyed() && win.isVisible() && !win.isMinimized()
    if (should && !this.timer) this.timer = setInterval(() => this.tick(), POLL_MS)
    else if (!should && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  keepOpen() {
    const { ctx } = this
    return ctx.bar.pinned || ctx.overlay || ctx.bar.hover || ctx.popupOpen
  }

  tick() {
    const { ctx } = this
    if (ctx.quitting || ctx.win.isDestroyed()) return this.stop()
    const pt = screen.getCursorScreenPoint()
    const b = ctx.win.getContentBounds()
    const insideX = pt.x >= b.x && pt.x < b.x + b.width
    const dy = pt.y - b.y
    if (insideX && dy >= 0 && dy <= REVEAL_PX) {
      this.awaySince = null
      this.show()
      return
    }
    if (!ctx.bar.visible) return
    if (this.keepOpen()) {
      this.awaySince = null
      return
    }
    const away = !insideX || dy < 0 || dy > HIDE_BELOW
    if (!away) {
      this.awaySince = null
      return
    }
    if (this.awaySince == null) this.awaySince = Date.now()
    else if (Date.now() - this.awaySince >= HIDE_DELAY) this.hide()
  }

  show() {
    const { ctx } = this
    if (ctx.quitting || ctx.win.isDestroyed()) return
    clearTimeout(this.viewTimer)
    this.viewTimer = null
    if (ctx.bar.visible && ctx.uiView.getVisible && ctx.uiView.getVisible()) return
    ctx.bar.visible = true
    ctx.layout()
    ctx.flush() // state first, then the view
    ctx.uiView.setVisible(true)
    ctx.win.setWindowButtonVisibility(true)
  }

  hide() {
    const { ctx } = this
    if (ctx.quitting || ctx.win.isDestroyed()) return
    if (!ctx.bar.visible) return
    this.awaySince = null
    ctx.bar.visible = false
    ctx.flush()
    ctx.win.setWindowButtonVisibility(false)
    clearTimeout(this.viewTimer)
    this.viewTimer = setTimeout(() => {
      this.viewTimer = null
      if (ctx.quitting || ctx.win.isDestroyed()) return
      if (!ctx.bar.visible && !ctx.overlay) ctx.uiView.setVisible(false)
    }, VIEW_HIDE_DELAY)
  }

  // Hide without the exit animation, so the next mouse events go straight to the page.
  hideNow() {
    const { ctx } = this
    if (ctx.quitting || ctx.win.isDestroyed() || ctx.overlay || ctx.bar.pinned) return
    this.hide()
    clearTimeout(this.viewTimer)
    this.viewTimer = null
    ctx.uiView.setVisible(false)
  }

  setPinned(pinned) {
    const { ctx } = this
    if (ctx.bar.pinned === pinned) return
    ctx.bar.pinned = pinned
    if (pinned) this.show()
    ctx.layout()
    ctx.push()
    ctx.saveSession()
    ctx.rebuildMenu && ctx.rebuildMenu()
  }

  setHover(h) {
    this.ctx.bar.hover = !!h
    if (h) this.awaySince = null
  }

  setPopupOpen(open) {
    this.ctx.popupOpen = open
    this.awaySince = null
  }

  openOverlay(mode, initial) {
    const { ctx } = this
    if (ctx.quitting || ctx.win.isDestroyed()) return
    ctx.overlay = { type: 'omnibox', mode, initial: initial || '', nonce: Date.now() } // nonce: re-open selects again
    this.show()
    ctx.layout()
    ctx.flush()
    ctx.uiView.setVisible(true)
    ctx.uiView.webContents.focus()
  }

  closeOverlay(refocus = true) {
    const { ctx } = this
    if (!ctx.overlay) return
    ctx.overlay = null
    ctx.layout()
    ctx.flush()
    if (refocus) ctx.tabs.focusActive()
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
    clearTimeout(this.viewTimer)
    this.viewTimer = null
  }
}

module.exports = { Reveal }
